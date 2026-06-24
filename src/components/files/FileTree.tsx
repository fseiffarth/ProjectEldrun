import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWindowsStore } from "../../stores/windows";
import { useTabsStore } from "../../stores/tabs";
import { useDragStore, type EmbedCap } from "../../stores/drag";
import { commitFileDrop } from "../tabs/commitFileDrop";
import { useSettingsStore } from "../../stores/settings";
import { useActivityStore } from "../../stores/activity";
import { type FileEntry, type InternalViewer, type SortKey, fileIcon, folderIcon, fmtSize, fmtModified, relFromAbs, visibleEntries, hiddenEntries, internalViewerFor, fileEntriesEqual, stringMapsEqual, STANDARD_PROJECT_FILES } from "../../lib/viewers/fileUtils";
import { type TexCapability, type TexCompileResult, getTexCapability, lastLogLine } from "../../lib/viewers/tex";
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
}

type GitStatusMap = Record<string, string>;
type EntryContextMenu = { x: number; y: number; entry: FileEntry | null } | null;
type DeleteConfirm = { entry: FileEntry; relPath: string } | null;

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
 *  Ignored → gray ✕ glyph; unpushed → green ↑ glyph; everything else → a
 *  colored dot (red unstaged/untracked, orange staged); clean → empty slot. */
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
  if (status === "ignored" || status === "unpushed") {
    return (
      <span style={{ ...slot, color: STATUS_COLOR[status] }} title={STATUS_TITLE[status]}>
        {status === "ignored" ? "✕" : "↑"}
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

function pathToFileUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
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
  // Whether the Alt key is currently held. While held, file rows arm NATIVE
  // HTML5 drag-and-drop (export the file to an embedded browser / external
  // target) instead of the pointer-based drag-to-tab. The two can't both be
  // armed on the same drag (native DnD fires pointercancel on WebKitGTK and
  // breaks the pointer drag — see onEntryPointerDown's R6 note), so Alt is the
  // explicit switch. Tracked as state so `draggable` re-evaluates per row when
  // Alt is pressed/released.
  const [altHeld, setAltHeld] = useState(false);
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; entry: FileEntry } | null>(null);
  const [contextMenu, setContextMenu] = useState<EntryContextMenu>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [defaultAppFor, setDefaultAppFor] = useState<FileEntry | null>(null);
  // TeX toolchain presence (null until probed); absolute paths of .tex files
  // currently compiling, for the inline build spinner.
  const [texCap, setTexCap] = useState<TexCapability | null>(null);
  const [compiling, setCompiling] = useState<Set<string>>(new Set());
  const { openFile } = useWindowsStore();
  const addTab = useTabsStore((s) => s.addTab);
  const runInBackground = useSettingsStore((s) => s.settings?.run_scripts_in_background ?? true);
  const runningScripts = useActivityStore((s) => s.runningScripts);
  const runScript = useActivityStore((s) => s.runScript);

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
    const viewer = internalViewerFor(e);
    if (viewer) return viewer;
    return isEmbeddable(e) ? "embed" : null;
  };

  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((cap) => { if (!cancelled) setTexCap(cap); });
    return () => { cancelled = true; };
  }, []);

  // Track Alt so file rows can switch to native DnD (export to browser) while
  // it's held. Also clear on blur/visibility loss so a release that happens
  // while another window has focus doesn't leave rows stuck in native-drag mode.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const clear = () => setAltHeld(false);
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
    load(initialRelPath ?? "");
  }, [projectDir]);

  // Live updates: watch the currently-displayed directory on the backend and
  // re-fetch when it changes, so files created/removed by terminals, agents, or
  // other processes appear without manual navigation. Re-points to the new
  // directory whenever relPath changes; tears down on unmount/panel close.
  useEffect(() => {
    if (!projectDir) return;
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
  }, [projectDir, relPath]);

  async function load(rel: string) {
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
    } else {
      openFile(entry.path, undefined, projectId, "right_file_tree").catch(console.error);
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
    const fileUri = pathToFileUri(entry.path);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/uri-list", fileUri);
    e.dataTransfer.setData("text/plain", entry.path);
    if (!entry.is_dir) {
      e.dataTransfer.setData(
        "DownloadURL",
        `${entry.mime || "application/octet-stream"}:${entry.name}:${fileUri}`,
      );
    }
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
    viewer: InternalViewer | null,
  ) {
    if (e.button !== 0 || entry.is_dir) return;
    // Alt held → the user wants to EXPORT this file (drag it into an embedded
    // browser / external target) via native HTML5 DnD, which the row arms while
    // `altHeld` (see renderEntry's `draggable`/`onDragStart`). Bail out without
    // preventDefault so native DnD takes over instead of the pointer drag-to-tab.
    if (e.altKey) return;
    // Let the inline run (▶) button own its own clicks — don't seed a drag or
    // swallow the click when the press lands on it.
    if ((e.target as HTMLElement).closest(".file-run-btn")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

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
      }
      useDragStore.getState().move(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!dragging) {
        // Never moved → a plain click does NOT open. Opening a file is a
        // double-click (onDoubleClick → handleClick); dragging it onto a tab bar
        // is the other gesture. So a single click is a no-op here.
        return;
      }
      const d = useDragStore.getState().drag;
      if (d != null) {
        // Released OUTSIDE the main window (e.g. dragged onto another monitor):
        // open the file in its own standalone detached window at the cursor. The
        // pointer's implicit capture keeps delivering coords past the viewport,
        // so client coords outside [0,inner) is the outside-the-window signal.
        const outside =
          ev.clientX < 0 ||
          ev.clientY < 0 ||
          ev.clientX >= window.innerWidth ||
          ev.clientY >= window.innerHeight;
        const detachBounds = outside
          ? {
              x: Math.round(ev.screenX - 80),
              y: Math.round(ev.screenY - 8),
              w: 900,
              h: 640,
            }
          : null;
        commitFileDrop(d, projectId, projectDir, detachBounds);
        useDragStore.getState().end();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function relForEntry(entry: FileEntry): string {
    return relPath ? `${relPath}/${entry.name}` : entry.name;
  }

  function showEntryContextMenu(e: React.MouseEvent<HTMLDivElement>, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    setTooltip(null);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
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

  function showRootContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    setTooltip(null);
    setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
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
      label: pdfPath.split("/").filter(Boolean).pop() ?? pdfPath,
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

  return (
    <div
      className={`file-tree${isDragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseDown={() => setContextMenu(null)}
      onContextMenu={showRootContextMenu}
    >
      {relPath && (
        <div className="file-tree-breadcrumb">
          <button className="file-tree-up" onClick={goUp} title="Go up">↑</button>
          <button className="file-tree-crumb" onClick={() => load("")} title="Project root">⌂</button>
          {relPath.split("/").filter(Boolean).map((seg, i, arr) => {
            const target = arr.slice(0, i + 1).join("/");
            const isLast = i === arr.length - 1;
            return (
              <React.Fragment key={target}>
                <span className="file-tree-crumb-sep">/</span>
                <button
                  className={`file-tree-crumb${isLast ? " current" : ""}`}
                  onClick={() => { if (!isLast) load(target); }}
                  title={target}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
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
          const viewer = dragTarget === "embed" ? null : dragTarget;
          return (
            <div
              key={e.path}
              className={`file-entry ${e.is_dir ? "dir" : "file"}${dragTarget ? " embeddable" : ""}${isScaffold ? " scaffold" : ""}`}
              // Dirs: single-click navigates + native DnD (file export).
              // Files, plain drag: pointer-based drag onto a tab bar for
              // drag-to-tab files (built-in viewer OR embeddable handler); R6 —
              // native DnD disabled then so it can't hijack the pointer. Opened
              // by double-click.
              // Files, ALT held: arm native HTML5 DnD so any file can be dragged
              // out into an embedded browser / external target (the pointer
              // drag-to-tab bails on Alt, see onEntryPointerDown).
              onClick={e.is_dir ? () => handleClick(e) : undefined}
              onDoubleClick={e.is_dir ? undefined : () => handleClick(e)}
              onContextMenu={(ev) => showEntryContextMenu(ev, e)}
              draggable={e.is_dir || altHeld}
              onDragStart={
                e.is_dir || altHeld
                  ? (ev) => handleEntryDragStart(ev, e)
                  : (ev) => ev.preventDefault()
              }
              onPointerDown={dragTarget ? (ev) => onEntryPointerDown(ev, e, viewer) : undefined}
              onMouseEnter={(ev) => handleEntryMouseEnter(ev, e)}
              onMouseLeave={() => setTooltip(null)}
            >
              <GitMarker status={status} />
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
            </>
          )}
          {contextMenu.entry && (() => {
            const entry = contextMenu.entry;
            const status = gitStatuses[entry.name];
            const isTex = !entry.is_dir && entry.extension === ".tex";
            return (
              <>
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
