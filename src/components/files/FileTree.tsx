import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../common/Toggle";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useWindowsStore } from "../../stores/windows";
import { useTabsStore } from "../../stores/tabs";
import { useDragStore, type EmbedCap, type FileDragItem } from "../../stores/drag";
import { commitFileDrop, fileDropGoesToNewWindow } from "../tabs/commitFileDrop";
import { startDetachedDropSession } from "../tabs/detachedDropTargets";
import { closeTabsForDeletedPath, retargetTabsForRenamedPath } from "./fileTabSync";
import { startCursorPoll, desktopCursor, type PhysPoint } from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore, type SyncFileMeta } from "../../stores/sync";
import { useActivityStore } from "../../stores/activity";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import { type FileEntry, type InternalViewer, type SortKey, fileIcon, folderIcon, fmtSize, fmtModified, relFromAbs, visibleEntries, internalViewerFor, disabledViewers, fileEntriesEqual, stringMapsEqual, nextSelection, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import { type TexCapability, type TexCompileResult, getTexCapability, lastLogLine } from "../../lib/viewers/tex";
import { basename } from "../../lib/paths";
import { SetDefaultAppDialog } from "./SetDefaultAppDialog";
import { useClampToViewport } from "../../hooks/useClampToViewport";

// Persist whether the collapsed "gitignored" files section is expanded, so the
// choice survives right-panel hide/show and remounts (FileTree remounts each
// time the panel reopens). Mirrors GitHistory's localStorage view pref.
const GITIGNORED_EXPANDED_KEY = "eldrun.fileTree.gitignoredExpanded";

function sizeCategory(bytes: number): string {
  if (bytes < 10 * 1024) return "size-small";
  if (bytes < 500 * 1024) return "size-medium";
  if (bytes < 10 * 1024 * 1024) return "size-large";
  return "size-huge";
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
  initialRelPath?: string | null;
  onRelPathChange?: (relPath: string) => void;
  /** SSH-sync Phase 1: which side of a remote project this tree shows. `"remote"`
   *  = the host source with the sync overlay + select-to-sync affordance; `"local"`
   *  = the local mirror (browsed/watched as a plain local tree). Absent = a normal
   *  local/remote project tree (no sync UI). */
  syncSource?: "remote" | "local";
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function FileTree({
  projectDir,
  projectId,
  localFile = null,
  sortKey = "name",
  descending = false,
  hiddenEndings = [],
  hiddenPaths = [],
  shownPaths = [],
  initialRelPath = "",
  onRelPathChange,
  syncSource,
}: Props) {
  const [rawEntries, setRawEntries] = useState<FileEntry[]>([]);
  // Recursive folder sizes (bytes), keyed by absolute folder path. Filled in
  // lazily by a per-folder backend `dir_size` call so a big subtree never blocks
  // the listing — the tree renders immediately and each folder's size appears
  // once it resolves. `requestedSizes` guards against re-dispatching the same
  // folder while it's in flight (or after it failed), so fs-watch churn doesn't
  // trigger a request storm; both reset in `load()` (navigation / refresh) so a
  // re-listed folder recomputes.
  const [dirSizes, setDirSizes] = useState<Record<string, number>>({});
  const requestedSizes = useRef<Set<string>>(new Set());
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
  // Drag-to-move: the rel path of the folder / breadcrumb under the cursor while
  // a file is being dragged (null = none). The ref carries the live value into
  // the drag's window-bound release handler (which captured an earlier closure);
  // the state drives the drop-target highlight and only changes when the hovered
  // target changes (not every pointermove), so the tree re-renders rarely.
  const moveTargetRef = useRef<string | null>(null);
  const [moveTargetRel, setMoveTargetRel] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
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
  // SSH-sync: the amber "resolve" popup for a diverged file — its local+host
  // metadata, the git diff when one is available (null until loaded, "" = none),
  // and the take-local/take-remote busy flag.
  const [syncResolve, setSyncResolve] = useState<{
    entry: FileEntry;
    rel: string;
    meta: SyncFileMeta | null;
    diff: string | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
  } | null>(null);
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
  const { openFile } = useWindowsStore();
  const addTab = useTabsStore((s) => s.addTab);
  const runInBackground = useSettingsStore((s) => s.settings?.run_scripts_in_background ?? true);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const runningScripts = useActivityStore((s) => s.runningScripts);
  const runScript = useActivityStore((s) => s.runScript);
  // Mount-free remote (Phase 2): a remote project lists over SFTP and has no
  // local inotify watcher, so we skip the fs-watch wiring and offer a manual
  // refresh control instead. Local projects keep live watch-driven updates.
  const isRemote = useProjectsStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.remote,
  );
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
  const syncProgress = useSyncStore((s) => (projectId ? s.progressByProject[projectId] : undefined));
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const syncPull = useSyncStore((s) => s.pull);
  const syncPush = useSyncStore((s) => s.push);
  const syncFileMeta = useSyncStore((s) => s.fileMeta);
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

  // Lazily compute the recursive size of each visible folder. Fires one backend
  // call per not-yet-requested folder (concurrently — they're independent) and
  // fills `dirSizes` as each resolves. A failed call is left unresolved; the
  // `requestedSizes` guard keeps it (and steady-state re-renders / fs-watch
  // reloads) from re-dispatching.
  useEffect(() => {
    const pending = entries.filter((e) => e.is_dir && !requestedSizes.current.has(e.path));
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    let cancelled = false;
    for (const e of pending) {
      invoke<number>("dir_size", { projectDir, relPath: relForEntry(e) })
        .then((bytes) => {
          if (!cancelled) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Total bytes contained in each section, kept separate rather than merged
  // into one figure — the point of splitting scaffold/gitignored out visually
  // is that their weight (e.g. a huge gitignored build dir) shouldn't hide
  // inside the "real" content total. Sums whatever `dirSizes`/`e.size` already
  // know; unresolved subfolder sizes count as 0 until their `dir_size` call
  // lands, same best-effort as the per-row display above.
  const groupSizes = useMemo(() => {
    const total = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirSizes[e.path] ?? 0) : e.size), 0);
    return { regular: total(sections.regular), standard: total(sections.standard), gitignored: total(sections.gitignored) };
  }, [sections, dirSizes]);

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
    // by the time the user starts a Ctrl-drag.
    void warmDragIcon();
    const sync = (e: KeyboardEvent) => setCtrlHeld(e.ctrlKey);
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
    setLoading(true);
    setError(null);
    // Navigating into a different folder abandons the current selection (its
    // paths aren't on screen anymore). The quiet fs-watch `refresh()` deliberately
    // does NOT clear — a background re-list must not wipe an in-progress selection.
    clearSelection();
    // Re-listing (navigation or an explicit refresh) recomputes folder sizes:
    // drop the cache + in-flight guard so the effect re-requests them fresh. The
    // quiet fs-watch `refresh()` deliberately does NOT do this — folder sizes
    // stay put through watch churn.
    requestedSizes.current.clear();
    setDirSizes({});
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
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

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

  function handleClick(entry: FileEntry) {
    if (entry.is_dir) {
      const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
      load(rel);
    } else if (entry.extension === ".zip") {
      // A zip "opens" by extracting in place into a sibling folder, then
      // navigating into it — rather than handing the archive to an external app.
      void extractArchive(entry);
    } else {
      openFile(entry.path, undefined, projectId, "right_file_tree").catch(console.error);
    }
  }

  // Single-click routing. A plain click on a folder navigates into it (and
  // drops any selection); every other click — a file, or a modifier-click on a
  // folder — drives the multi-selection instead (shift = range, ctrl/cmd =
  // toggle). Opening a file stays a double-click (onDoubleClick → handleOpen).
  function handleRowClick(ev: React.MouseEvent, entry: FileEntry) {
    const hasMod = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (entry.is_dir && !hasMod) {
      clearSelection();
      handleClick(entry);
      return;
    }
    selectFromClick(entry, ev);
  }

  // Open a file on double-click. If it belongs to a multi-selection, open EVERY
  // selected file (each in its own tab); otherwise just this one. Folders keep
  // navigating via handleClick.
  function handleOpen(entry: FileEntry) {
    if (entry.is_dir) {
      handleClick(entry);
      return;
    }
    const targets =
      selected.has(entry.path) && selected.size > 1
        ? entries.filter((e) => !e.is_dir && selected.has(e.path))
        : [entry];
    for (const t of targets) {
      if (t.extension === ".zip") void extractArchive(t);
      else openFile(t.path, undefined, projectId, "right_file_tree").catch(console.error);
    }
  }

  // Keyboard on the focused tree: Enter opens every selected file, Escape drops
  // the selection. Only acts while something is selected so it never steals keys
  // from the rest of the panel.
  function handleTreeKeyDown(ev: React.KeyboardEvent) {
    if (selected.size === 0) return;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      clearSelection();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      for (const t of entries.filter((e) => !e.is_dir && selected.has(e.path))) {
        if (t.extension === ".zip") void extractArchive(t);
        else openFile(t.path, undefined, projectId, "right_file_tree").catch(console.error);
      }
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
    if (entry.modified_secs || entry.created_secs) {
      setTooltip({ rect: e.currentTarget.getBoundingClientRect(), entry });
    }
  }

  function handleEntryDragStart(e: React.DragEvent<HTMLDivElement>, entry: FileEntry) {
    // WebKitGTK's HTML5 drag-out renders no drag image outside the window and
    // doesn't reliably export the file to other apps, so suppress it and hand
    // off to the native OS drag (tauri-plugin-drag): real OLE/NSDragging/GTK
    // drag, with an OS-rendered icon that crosses into Signal / a browser / a
    // file manager / the desktop. `mode: "copy"` so the file is never MOVED out
    // of the project. The preview icon path was warmed at mount (warmDragIcon).
    e.preventDefault();
    const begin = (icon: string) =>
      startDrag({ item: [entry.path], icon, mode: "copy" }).catch((err) =>
        // Surfaces the most common failure: the backend wasn't rebuilt, so the
        // `plugin:drag|start_drag` command (and `drag_preview_icon`) don't exist
        // yet — the drag silently no-ops. Log it so the cause is visible.
        console.error("[eldrun] native file drag-out failed:", err),
      );
    // The icon data URL is normally warm by drag time; if not, resolve first.
    if (dragIconDataUrl) void begin(dragIconDataUrl);
    else void warmDragIcon().then(begin);
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
    if (e.ctrlKey) return;
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

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragging = true;
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
          } catch {
            /* capture is best-effort; the OS-cursor poll does not depend on it */
          }
        }
        // Poll the OS cursor (physical desktop px) to drive the popout hover past
        // the main viewport — DOM pointermove may not cross the OS window boundary.
        stopPoll = startCursorPoll((p) => {
          lastPhys = p;
          detached.hover(detached.at(p), p, entry.name);
        });
      }
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
    };

    // Tear down the move listener, poll, popout highlight, and pointer capture —
    // however the gesture resolves.
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      setMoveTarget(null);
      stopPoll?.();
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
      // Read the drop-target folder BEFORE cleanup() runs — cleanup calls
      // setMoveTarget(null), which nulls moveTargetRef.current, so reading it
      // afterwards always saw null and silently dropped every drag-to-move (the
      // file just stayed put). See git dfcb6e0, which introduced the read below
      // the cleanup() call.
      const moveRel = moveTargetRef.current;
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
      commitFileDrop(d, projectId, projectDir, detachBounds);
      useDragStore.getState().end();
    };

    // Escape / blur / a genuine pointercancel (Win/mac) aborts: tear down and drop
    // any in-flight drag without committing.
    const onAbort = () => {
      cleanup();
      if (dragging) useDragStore.getState().end();
    };

    window.addEventListener("pointermove", onMove);
    bindDragRelease({ onCommit: (shiftKey) => void commitRelease(shiftKey), onAbort });
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

  /** SSH-sync: open the amber "resolve" popup for a diverged file. Shows the
   *  local vs host metadata (size/mtime) and, when the host copy yields a text
   *  diff, the git diff itself; otherwise (binary / one side missing / no diff)
   *  it just offers take-local / take-remote. Uses `relForEntry` for the correct
   *  project-relative key — the old diff *tab* recomputed the rel from an
   *  absolute path via the DiffView, which came out empty on the remote view
   *  (the host path isn't under the local project dir) and made `sync_diff`
   *  point at the mirror ROOT ("git could not access …/.tmpXXX"). */
  function openSyncResolve(entry: FileEntry) {
    setContextMenu(null);
    if (!projectId) return;
    const rel = relForEntry(entry);
    setSyncResolve({ entry, rel, meta: null, diff: null, loading: true, busy: false, error: null });
    // Fetch metadata and the git diff together; either may fail independently
    // (a cold pool fails both; a binary/identical file just yields no diff).
    void Promise.allSettled([
      syncFileMeta(projectId, rel),
      invoke<string>("sync_diff", { projectId, relPath: rel }),
    ]).then(([metaR, diffR]) => {
      setSyncResolve((s) => {
        if (!s || s.rel !== rel) return s; // superseded by another open
        return {
          ...s,
          loading: false,
          meta: metaR.status === "fulfilled" ? metaR.value : null,
          diff: diffR.status === "fulfilled" ? diffR.value : "",
          error: metaR.status === "rejected" ? String(metaR.reason) : null,
        };
      });
    });
  }

  /** Resolve the amber divergence: "remote" pulls the host copy over the mirror,
   *  "local" force-pushes the mirror over the host. Both clear amber → green. */
  async function resolveSyncDivergence(action: "local" | "remote") {
    if (!syncResolve || !projectId) return;
    const rel = syncResolve.rel;
    setSyncResolve((s) => (s ? { ...s, busy: true, error: null } : s));
    try {
      if (action === "remote") await syncPull(projectId, rel);
      else await syncPush(projectId, rel, true);
      await refreshSyncStatus(projectId);
      await load(relPath);
      setSyncResolve(null);
    } catch (err) {
      setSyncResolve((s) => (s ? { ...s, busy: false, error: String(err) } : s));
    }
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
    if (runInBackground) {
      // Detached spawn: no tab, no captured output. The activity store tracks
      // the run (and the app-lifetime `script-finished` listener clears it) so
      // the spinner survives right-panel hide/show — see TODO group R #34.
      runScript(entry.path, projectDir);
      return;
    }
    const scriptRel = relFromAbs(projectDir, entry.path);
    addTab({
      label: entry.name,
      cmd: "bash",
      cwd: projectDir,
      kind: "shell",
      initialInput: `bash ${shellQuote(scriptRel)}`,
    });
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

  return (
    <div
      className={`file-tree${isDragOver ? " drag-over" : ""}`}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleTreeKeyDown}
      onMouseDown={() => setContextMenu(null)}
      onContextMenu={showRootContextMenu}
    >
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
      {relPath && (() => {
        // Parent of the current folder — the up button doubles as a drag-to-move
        // target ("move into the parent dir"). The breadcrumb crumbs cover the
        // other ancestors (and ⌂ the project root).
        const parentRel = relPath.split("/").filter(Boolean).slice(0, -1).join("/");
        return (
        <div className="file-tree-breadcrumb">
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
            return (
              <React.Fragment key={target}>
                <span className="file-tree-crumb-sep">/</span>
                <button
                  className={`file-tree-crumb${isLast ? " current" : ""}${moveTargetRel === target ? " move-drop-target" : ""}`}
                  data-move-rel={target}
                  onClick={() => { if (!isLast) load(target); }}
                  title={target}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
          <span className="file-tree-path-total" title="Total size of the files shown here">
            {fmtSize(groupSizes.regular)}
          </span>
        </div>
        );
      })()}
      {loading && <div className="file-tree-loading">Loading…</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {!relPath && (
        <label className="file-tree-scaffold-toggle">
          <Toggle size="sm" checked={separateScaffold} onChange={(e) => setSeparateScaffold(e.target.checked)} />
          Separate scaffold
          <span className="file-tree-path-total" title="Total size of the files shown here">
            {fmtSize(groupSizes.regular)}
          </span>
        </label>
      )}
      {(() => {
        // Sections (regular / collapsible scaffold / collapsible gitignored) are
        // computed once in the `sections` memo above and shared with the
        // selection click handler so a shift-range spans exactly these rows.
        const { regular, standard, gitignored } = sections;

        function renderEntry(e: FileEntry, isScaffold = false, isGitignored = false) {
          const status = isGitignored ? undefined : gitStatuses[e.name];
          const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
          const canRun = !e.is_dir && e.extension === ".sh";
          const isRunning = runningScripts.has(e.path);
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
          const syncState = syncTracked ? syncStatus?.[rel]?.state ?? "none" : "none";
          // Auto-sync glyph: shown on both the remote and local trees when this
          // path (or an ancestor auto folder) is set to auto-sync. Coexists with
          // the amber ± button — an auto path that went orange is exactly what the
          // user must resolve manually.
          const autoSync = syncTracked ? !!syncStatus?.[rel]?.auto : false;
          return (
            <div
              key={e.path}
              className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${isScaffold || isGitignored ? " scaffold" : ""}${isMoveTarget ? " move-drop-target" : ""}${selected.has(e.path) ? " selected" : ""}`}
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
              onDoubleClick={e.is_dir ? undefined : () => handleOpen(e)}
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
                        openSyncResolve(e);
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
                  title={isRunning ? `Running ${e.name}…` : `Run ${e.name}`}
                  aria-label={isRunning ? `Running ${e.name}` : `Run ${e.name}`}
                  onClick={(ev) => runShellScript(ev, e)}
                  disabled={isRunning}
                >
                  {isRunning ? <span className="file-run-spinner" /> : "▶"}
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
              <span className="file-name" title={e.name}>{e.name}</span>
              {e.is_dir
                ? dirSizes[e.path] !== undefined && (
                    <span className={`file-size ${sizeCategory(dirSizes[e.path])}`}>
                      {fmtSize(dirSizes[e.path])}
                    </span>
                  )
                : <span className={`file-size ${sizeClass}`}>{fmtSize(e.size)}</span>}
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
                  <span className="file-tree-path-total" title="Total size of the scaffold group">
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
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu file-browser-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!contextMenu.entry && (
            <>
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
      {syncResolve && createPortal(
        <div className="modal-backdrop" onMouseDown={() => !syncResolve.busy && setSyncResolve(null)}>
          <div
            className="file-delete-dialog"
            style={{ maxWidth: 560, width: "min(560px, 92vw)" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2>Local and host differ</h2>
            <div className="file-delete-path">{syncResolve.rel}</div>
            {syncResolve.loading ? (
              <p style={{ color: "var(--text-muted)" }}>Comparing local mirror and host…</p>
            ) : syncResolve.meta ? (
              (() => {
                const { local, host } = syncResolve.meta!;
                const sizeDiff = local.size !== host.size;
                const timeDiff = (local.mtime ?? null) !== (host.mtime ?? null);
                const cell = (present: boolean, text: string, diff: boolean) => (
                  <td style={{ padding: "3px 10px", color: !present ? "var(--text-muted)" : diff ? "var(--warning, #d29922)" : "var(--text-primary)" }}>
                    {present ? text : "—"}
                  </td>
                );
                return (
                  <table style={{ borderCollapse: "collapse", margin: "6px 0", fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: "var(--text-muted)" }}>
                        <th style={{ textAlign: "left", padding: "3px 10px", fontWeight: 500 }} />
                        <th style={{ textAlign: "left", padding: "3px 10px", fontWeight: 600 }}>Local</th>
                        <th style={{ textAlign: "left", padding: "3px 10px", fontWeight: 600 }}>Host (remote)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ padding: "3px 10px", color: "var(--text-muted)" }}>Present</td>
                        {cell(true, local.exists ? "yes" : "no", local.exists !== host.exists)}
                        {cell(true, host.exists ? "yes" : "no", local.exists !== host.exists)}
                      </tr>
                      <tr>
                        <td style={{ padding: "3px 10px", color: "var(--text-muted)" }}>Size</td>
                        {cell(local.exists, fmtSize(local.size), sizeDiff)}
                        {cell(host.exists, fmtSize(host.size), sizeDiff)}
                      </tr>
                      <tr>
                        <td style={{ padding: "3px 10px", color: "var(--text-muted)" }}>Modified</td>
                        {cell(local.exists, fmtModified(local.mtime) || "—", timeDiff)}
                        {cell(host.exists, fmtModified(host.mtime) || "—", timeDiff)}
                      </tr>
                    </tbody>
                  </table>
                );
              })()
            ) : (
              <p style={{ color: "var(--danger, #f85149)" }}>
                {syncResolve.error ?? "Could not read file metadata."}
              </p>
            )}
            {/* Git diff when one is available; otherwise a note pointing at the
                take-local / take-remote choice below. */}
            {!syncResolve.loading && (syncResolve.diff ? (
              <pre
                style={{
                  maxHeight: 240, overflow: "auto", margin: "4px 0 0",
                  padding: 8, fontSize: 11, lineHeight: 1.4,
                  background: "var(--bg-inset, rgba(0,0,0,0.25))", borderRadius: 4,
                  whiteSpace: "pre", fontFamily: "var(--font-mono, monospace)",
                }}
              >
                {syncResolve.diff}
              </pre>
            ) : syncResolve.meta ? (
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
                No line diff available (binary, identical text, or one side missing).
                Choose which copy to keep.
              </p>
            ) : null)}
            {syncResolve.meta && syncResolve.error && (
              <p style={{ fontSize: 11, color: "var(--danger, #f85149)", margin: "4px 0 0" }}>
                {syncResolve.error}
              </p>
            )}
            <div className="file-delete-actions">
              <button type="button" disabled={syncResolve.busy} onClick={() => setSyncResolve(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={syncResolve.busy || syncResolve.loading}
                title="Pull the host copy over your local mirror"
                onClick={() => void resolveSyncDivergence("remote")}
              >
                Take remote
              </button>
              <button
                type="button"
                className="danger"
                disabled={syncResolve.busy || syncResolve.loading}
                title="Force-push your local copy over the host"
                onClick={() => void resolveSyncDivergence("local")}
              >
                Take local
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
                borderRadius: 3,
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
          style={{ right: window.innerWidth - tooltip.rect.left + 8, top: tooltip.rect.top }}
        >
          {tooltip.entry.created_secs && (
            <div><span className="file-tooltip-label">Created </span>{fmtModified(tooltip.entry.created_secs)}</div>
          )}
          {tooltip.entry.modified_secs && (
            <div><span className="file-tooltip-label">Modified</span>{fmtModified(tooltip.entry.modified_secs)}</div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
