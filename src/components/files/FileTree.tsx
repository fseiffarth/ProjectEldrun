import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { useWindowsStore } from "../../stores/windows";
import { useTabsStore } from "../../stores/tabs";
import { useDragStore, type EmbedCap } from "../../stores/drag";
import { commitFileDrop } from "../tabs/commitFileDrop";
import { startDetachedDropSession } from "../tabs/detachedDropTargets";
import { startCursorPoll, desktopCursor, type PhysPoint } from "../../lib/coords";
import { bindDragRelease, dragPlatform } from "../../lib/dragPlatform";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useSyncStore, type SyncFileState } from "../../stores/sync";
import { useActivityStore } from "../../stores/activity";
import { useFileClipboardStore } from "../../stores/fileClipboard";
import { type FileEntry, type InternalViewer, type SortKey, fileIcon, folderIcon, fmtSize, fmtModified, relFromAbs, visibleEntries, hiddenEntries, internalViewerFor, disabledViewers, fileEntriesEqual, stringMapsEqual, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import { type TexCapability, type TexCompileResult, getTexCapability, lastLogLine } from "../../lib/viewers/tex";
import { basename } from "../../lib/paths";
import { SetDefaultAppDialog } from "./SetDefaultAppDialog";

// Persist whether the collapsed "hidden" files section is expanded, so the
// choice survives right-panel hide/show and remounts (FileTree remounts each
// time the panel reopens). Mirrors GitHistory's localStorage view pref.
const HIDDEN_EXPANDED_KEY = "eldrun.fileTree.hiddenExpanded";

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
  showHidden?: boolean;
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
type EntryContextMenu = { x: number; y: number; entry: FileEntry | null } | null;
type DeleteConfirm = { entry: FileEntry; relPath: string } | null;
/** Open paste-rename window: `kind` is whether the source is the in-app file
 *  clipboard or a system-clipboard image (screenshot); `name` is the name being
 *  chosen for the pasted result in the current folder. */
type PastePrompt = { kind: "file" | "image"; name: string; error: string | null };

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

const SYNC_COLOR: Record<SyncFileState, string> = {
  green: "#3fb950", // synced; manifest base still matches the host
  amber: "#d29922", // host moved since the last fetch (refresh-observed)
  none: "transparent",
};

const SYNC_TITLE: Record<SyncFileState, string> = {
  green: "Synced to local mirror",
  amber: "Host changed since last sync — re-sync to update",
  none: "Not synced",
};

/** SSH-sync Phase 1: marker right of the git dot in the REMOTE source view,
 *  showing whether a path is mirrored locally (green), stale (amber), or not
 *  synced (empty slot). Only rendered for remote-source trees. */
function SyncMarker({ state }: { state: SyncFileState | undefined }) {
  const slot: React.CSSProperties = {
    width: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginRight: 2,
  };
  const s = state ?? "none";
  return (
    <span style={slot} title={SYNC_TITLE[s]}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 2,
          background: SYNC_COLOR[s],
          boxShadow: s === "none" ? "inset 0 0 0 1px var(--border-color)" : undefined,
        }}
      />
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
  showHidden = false,
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
  // Which files can be embedded as a frameless in-tab app (Group K #40). Keyed
  // by extension (default-app resolution is per-mime/extension), so we only
  // query the backend once per distinct extension. Only embeddable files get the
  // drag-to-tab affordance (3D hover + pointer drag); the rest open on dblclick.
  const [embedByExt, setEmbedByExt] = useState<Record<string, boolean>>({});
  const [relPath, setRelPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitStatuses, setGitStatuses] = useState<GitStatusMap>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const [separateScaffold, setSeparateScaffold] = useState(true);
  const [hiddenExpanded, setHiddenExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDDEN_EXPANDED_KEY) === "1";
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
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
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
  const clipboard = useFileClipboardStore((s) => s.entry);
  const setClipboard = useFileClipboardStore((s) => s.setEntry);
  const clearClipboard = useFileClipboardStore((s) => s.clear);
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
  const syncMarkSelected = useSyncStore((s) => s.markSelected);
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

  const entries = useMemo(
    () => visibleEntries(rawEntries, {
      showHidden,
      showStandardFiles: true,
      sortKey,
      descending,
      hiddenEndings,
      relPath,
      hiddenPaths,
      shownPaths,
    }),
    [rawEntries, showHidden, sortKey, descending, hiddenEndings, relPath, hiddenPaths, shownPaths],
  );

  // Dotfiles hidden from the inline tree, surfaced in a collapsed section so they
  // stay discoverable without flooding the tree (TODO group N #29). Shown
  // independently of the scaffold split — see the render below.
  const hidden = useMemo(
    () => hiddenEntries(rawEntries, {
      showHidden,
      sortKey,
      descending,
      hiddenEndings,
      relPath,
      hiddenPaths,
      shownPaths,
    }),
    [rawEntries, showHidden, sortKey, descending, hiddenEndings, relPath, hiddenPaths, shownPaths],
  );

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

  // SSH-sync Phase 1: keep the remote-source overlay fresh — re-stat selected
  // files whenever the remote tree (re)lists. Skipped for local/​mirror trees.
  useEffect(() => {
    if (remoteListing && projectId && !remoteBlocked) {
      void refreshSyncStatus(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteListing, projectId, remoteBlocked, relPath]);

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
    const sourceRel = relForEntry(entry);
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
          label: entry.name,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          filePath: entry.path,
          fileName: entry.name,
          viewer: viewer ?? undefined,
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
      cleanup();
      if (!dragging) {
        // Never moved → a plain click does NOT open. Opening a file is a
        // double-click (onDoubleClick → handleClick); dragging it onto a tab bar
        // is the other gesture. So a single click is a no-op here.
        return;
      }
      // Drag-to-move takes precedence: released over a folder / breadcrumb in the
      // tree → relocate the file there. This is the one gesture available to ALL
      // files (even those with no tab/viewer target).
      const moveRel = moveTargetRef.current;
      if (moveRel != null) {
        useDragStore.getState().end();
        await moveEntryToFolder(sourceRel, entry.name, moveRel);
        return;
      }
      const d = useDragStore.getState().drag;
      if (d == null) return;
      // A file with no tab/viewer/embed target can only be moved (handled above);
      // released anywhere else it does nothing — never leak it out as an external
      // open or an empty embed tab.
      if (!canTab) {
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
      // Released OUTSIDE the main window (e.g. dragged onto another monitor), or
      // over an OCCLUDED popout (handled above): open the file in its own
      // standalone detached window at the cursor. Client coords outside [0,inner)
      // — or being over a popout's bounds at all — is the signal. The new window's
      // bounds feed Rust `.position(x,y)`, which is PHYSICAL → use the physical
      // cursor, not DOM screen coords.
      //
      // Shift forces a new window even when released INSIDE the main window: the
      // split/dock preview was suppressed during the drag (see CenterPanel's
      // pointer-move handler), so the only sensible commit is a fresh window.
      const outside =
        shiftKey ||
        !!overDetached ||
        lastClient.x < 0 ||
        lastClient.y < 0 ||
        lastClient.x >= window.innerWidth ||
        lastClient.y >= window.innerHeight;
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
  async function moveEntryToFolder(sourceRel: string, name: string, destFolderRel: string) {
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
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
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

  function promptDelete(entry: FileEntry) {
    setContextMenu(null);
    setDeleteConfirm({ entry, relPath: relForEntry(entry) });
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

  function copyEntry(entry: FileEntry, op: "copy" | "cut") {
    setContextMenu(null);
    setClipboard({
      projectDir,
      relPath: relForEntry(entry),
      name: entry.name,
      isDir: entry.is_dir,
      op,
    });
  }

  /** Suggest a name not already present in the current folder, appending
   *  " copy"/" copy N" (before the extension) until it is free. */
  function suggestPasteName(name: string): string {
    const taken = new Set(rawEntries.map((e) => e.name));
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
        if (clipboard.op === "cut") clearClipboard();
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
    setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
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
    const target = deleteConfirm;
    setDeleteConfirm(null);
    setLoading(true);
    setError(null);
    try {
      await invoke(target.entry.is_dir ? "delete_dir" : "delete_file", {
        projectDir,
        relPath: target.relPath,
      });
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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
        </div>
        );
      })()}
      {loading && <div className="file-tree-loading">Loading…</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {!relPath && (
        <label className="file-tree-scaffold-toggle">
          <input type="checkbox" checked={separateScaffold} onChange={(e) => setSeparateScaffold(e.target.checked)} />
          Separate scaffold
        </label>
      )}
      {(() => {
        const isRoot = !relPath && separateScaffold;
        const regular = isRoot ? entries.filter((e) => !STANDARD_PROJECT_FILES.has(e.name)) : entries;
        const standard = isRoot ? entries.filter((e) => STANDARD_PROJECT_FILES.has(e.name)) : [];

        function renderEntry(e: FileEntry, isScaffold = false) {
          const status = gitStatuses[e.name];
          const sizeClass = !e.is_dir ? sizeCategory(e.size) : "";
          const canRun = !e.is_dir && e.extension === ".sh";
          const isRunning = runningScripts.has(e.path);
          const isCompiling = compiling.has(e.path);
          const dragTarget = draggableToTab(e);
          const isMoveTarget = e.is_dir && moveTargetRel === relForEntry(e);
          return (
            <div
              key={e.path}
              className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${isScaffold ? " scaffold" : ""}${isMoveTarget ? " move-drop-target" : ""}`}
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
              onClick={e.is_dir ? () => handleClick(e) : undefined}
              onDoubleClick={e.is_dir ? undefined : () => handleClick(e)}
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
              {/* SSH-sync Phase 1: per-path mirror state, remote source only. */}
              {remoteListing && (
                <SyncMarker state={syncStatus?.[relForEntry(e)]?.state} />
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
              {!e.is_dir && (
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
                </button>
                {scaffoldExpanded && standard.map((e) => renderEntry(e, true))}
              </>
            )}
            {hidden.length > 0 && (
              <>
                <button
                  type="button"
                  className="file-tree-section-divider file-tree-hidden-toggle"
                  aria-expanded={hiddenExpanded}
                  onClick={() => setHiddenExpanded((v) => {
                    const next = !v;
                    try { localStorage.setItem(HIDDEN_EXPANDED_KEY, next ? "1" : "0"); } catch { /* ignore storage failures */ }
                    return next;
                  })}
                  title={hiddenExpanded ? "Collapse hidden files" : "Expand hidden files"}
                >
                  <span className="file-tree-hidden-caret">{hiddenExpanded ? "▾" : "▸"}</span>
                  hidden ({hidden.length})
                </button>
                {hiddenExpanded && hidden.map((e) => renderEntry(e, true))}
              </>
            )}
          </>
        );
      })()}
      {contextMenu && createPortal(
        <div
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
              {clipboard && (
                <button onClick={openPastePrompt}>
                  Paste{clipboard.op === "cut" ? " (move)" : ""} “{clipboard.name}”
                </button>
              )}
              {clipboardImage && (
                <button onClick={openScreenshotPrompt}>
                  Paste screenshot
                </button>
              )}
            </>
          )}
          {contextMenu.entry && (() => {
            const entry = contextMenu.entry;
            const status = gitStatuses[entry.name];
            const isTex = !entry.is_dir && entry.extension === ".tex";
            const isZip = !entry.is_dir && entry.extension === ".zip";
            const syncSel = remoteListing ? syncStatus?.[relForEntry(entry)]?.selected : false;
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
                <button onClick={() => copyEntry(entry, "copy")}>
                  Copy
                </button>
                <button onClick={() => copyEntry(entry, "cut")}>
                  Cut
                </button>
                {clipboard && (
                  <button onClick={openPastePrompt}>
                    Paste{clipboard.op === "cut" ? " (move)" : ""} “{clipboard.name}”
                  </button>
                )}
                {clipboardImage && (
                  <button onClick={openScreenshotPrompt}>
                    Paste screenshot
                  </button>
                )}
                <hr />
                <button onClick={() => renameEntry(entry)}>
                  Rename
                </button>
                <button className="danger" onClick={() => promptDelete(entry)}>
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
            <h2>Delete {deleteConfirm.entry.is_dir ? "Folder" : "File"}</h2>
            <p>
              Delete <strong>{deleteConfirm.entry.name}</strong>? This permanently removes it from the project.
            </p>
            <div className="file-delete-path">{deleteConfirm.relPath}</div>
            <div className="file-delete-actions">
              <button type="button" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button type="button" className="danger" onClick={confirmDelete}>Delete</button>
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
