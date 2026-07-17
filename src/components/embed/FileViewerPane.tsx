import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useWindowsStore } from "../../stores/windows";
import {
  findGroupOfTab,
  getDetachedViewerState,
  useTabsStore,
  type ViewerState,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useExperimental } from "../../lib/experimental";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { useConnectDialogStore } from "../../stores/connectDialog";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { useLinkRoutingStore } from "../../stores/linkRouting";
import {
  useEditorJumpStore,
  hasMountedEditor,
  registerEditor,
  unregisterEditor,
} from "../../stores/editorJump";
import { usePdfSyncStore } from "../../stores/pdfSync";
import { useScrollSync } from "../../stores/scrollSync";
import { parseDetachedParam } from "../../stores/detached";
import { Dropdown } from "../common/Dropdown";
import { CompareView } from "./CompareView";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { enrichMarkdownDom } from "../../lib/viewers/markdownEnrich";
import { highlight, languageForPath, escapeHtml } from "../../lib/viewers/highlight";
import {
  printDocument,
  printHtmlBody,
  MARKDOWN_PRINT_CSS,
  TEXT_PRINT_CSS,
  IMAGE_PRINT_CSS,
} from "../../lib/viewers/print";
import {
  formatJsonText,
  isInProcessJson,
  formatLangForPath,
  validationLangForPath,
  previewKindForPath,
  buildPreviewDoc,
  type PreviewKind,
} from "../../lib/viewers/format";
import {
  toggleInline,
  cycleHeading,
  toggleLinePrefix,
  makeLink,
  generateToc,
  type EditResult,
} from "../../lib/viewers/markdownEdit";
import { internalViewerFor, disabledViewers, relFromAbs, type InternalViewer, type FileEntry } from "../../lib/viewers/fileUtils";
import {
  isPythonPath,
  pythonLinkRanges,
  remapBreakpoints,
  resolvePythonDefinition,
  snapBreakpointLine,
} from "../../lib/viewers/python";
import { debugPythonFile, runCwd, runPythonFile, placeForFocused } from "../../lib/pythonRun";
import { FileDropContext } from "../files/fileDropContext";
import {
  basename,
  dirname,
  fromFileUri,
  isPathWithin,
  normalizePath,
  resolvePath,
  toFileUri,
} from "../../lib/paths";
import { IS_MAC, IS_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  resolveProjectDirectory,
  resolveLocalMirror,
  type AutocompleteMode,
  type GrammarIssue,
} from "../../types";
import { useSyncStore } from "../../stores/sync";
import { ContextFilePicker } from "./ContextFilePicker";
import { useFileSourcesStore } from "../../stores/fileSources";
import {
  FileScopeContext,
  useFileScope,
  fileSource,
  type FileSource,
  readFileText,
  readFileBytes,
  writeFileText,
  fileMtime,
} from "./fileAccess";
import { TableView } from "./TableView";
import { NotebookView } from "./NotebookView";
import { DiffView } from "./DiffView";
import { OdtView } from "./OdtView";
import { MediaView } from "./MediaView";
import { GifView } from "./GifView";
import { SqliteView } from "./SqliteView";
import { ImageAnnotator } from "./ImageAnnotator";
import {
  type TexCapability,
  type TexCompileResult,
  type TexCompletions,
  type TexComplContext,
  getTexCapability,
  lastLogLine,
  type TexError,
  parseTexErrors,
  resolveTexErrorPath,
  findTexRefAt,
  findTexComplAt,
  parseTexLabels,
  gatherTexCompletions,
  resolveTexRefAsync,
  texRefRanges,
  synctexViewBest,
  pickSyncRect,
  sourceColumnFraction,
  resolveTexRoot,
  lineStartOffset,
  offsetToLineCol,
  phraseAt,
} from "../../lib/viewers/tex";
import { PdfView } from "./pdf/PdfViewer";
import { YamlTree } from "./YamlTree";
import { isTreePath, isJsonPath } from "../../lib/viewers/yaml";

/**
 * Persisted reader-position plumbing for an in-app viewer. Snapshots the tab's
 * saved `ViewerState` once (so the viewer restores scroll/zoom/pan from where the
 * reader left it on mount, rather than reacting to its own later writes) and
 * returns a stable `persist` that merges a patch back into the tab — flushed to
 * project.json by CenterPanel's debounced saveLayout, so the position survives an
 * Eldrun restart. A no-op when `tabKey` is absent (e.g. tests).
 */
/**
 * A tab's persisted `ViewerState` seed, read once. Normally from `useTabsStore`
 * (the main window owns the layout store); in a DETACHED window that store has
 * no entry for the tab — its tabs render from a Tauri seed into local React
 * state, not the store — so fall back to the detached seed registry. Without
 * this fallback a detached editor loses per-tab scroll/zoom and the #45
 * autocomplete/grammar toggles, silently reverting to the per-type defaults.
 */
function seedViewerState(tabKey: string | undefined): ViewerState | undefined {
  if (!tabKey) return undefined;
  return (
    useTabsStore.getState().tabs.find((t) => t.key === tabKey)?.viewerState ??
    getDetachedViewerState(tabKey)
  );
}

export function useViewerState(tabKey: string | undefined) {
  const [initial] = useState<ViewerState | undefined>(() => seedViewerState(tabKey));
  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );
  // Stable object so consumers can list `viewPos` in effect/callback deps without
  // re-running every render (`initial` and `persist` are both stable).
  return useMemo(() => ({ initial, persist }), [initial, persist]);
}

// The modifier that opens a recognised file link (Ctrl/Cmd+Click). Shown verbatim
// in the hover hint, so it must read as the key the user actually presses.
const OPEN_MODIFIER = IS_MAC ? "⌘" : "Ctrl";
const OPEN_LINK_HINT = `${OPEN_MODIFIER}+Click to open`;

/** A small floating "{Ctrl}+Click to open" hint, anchored just above a hovered
 *  file link (#49). `at` is viewport coordinates of the link's top-left, or null
 *  to hide. Purely informational: pointer-events:none so it never blocks a click. */
function LinkOpenHint({ at }: { at: { left: number; top: number } | null }) {
  if (!at) return null;
  return (
    <div className="link-open-hint" role="tooltip" style={{ left: at.left, top: at.top }}>
      {OPEN_LINK_HINT}
    </div>
  );
}

/** Pure zoom-to-cursor math for the image viewer (#52): given the current and
 *  next scale, the current top-left offset, and the viewport-local anchor the
 *  zoom should keep fixed, return the new offset. Extracted + tested. */
export function zoomOffset(
  prevScale: number,
  nextScale: number,
  offset: { x: number; y: number },
  anchor: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: anchor.x - ((anchor.x - offset.x) * nextScale) / prevScale,
    y: anchor.y - ((anchor.y - offset.y) * nextScale) / prevScale,
  };
}

/** A URI-list / DownloadURL dataTransfer payload for dragging a file out of the
 *  app as an OS-level drop source (#53). Mirrors FileTree's `file://` encoding. */
function pathToFileUri(path: string): string {
  return toFileUri(path);
}

/**
 * Populate a dragstart's dataTransfer so an image (or file) can be dropped OUT of
 * Eldrun into another app — a browser file-upload field, a chat, etc. (#53).
 * Publishes:
 *  - `text/uri-list` + `text/plain`: the canonical `file://` URI (most targets).
 *  - `DownloadURL`: `mime:name:url`, used by Chromium-family drop targets.
 * Exported so it can be unit-tested with a mock DataTransfer. Returns nothing;
 * receivers that ignore these types simply don't accept the drop.
 */
export function onImageDragStart(
  e: { dataTransfer: DataTransfer | null },
  path: string,
) {
  const dt = e.dataTransfer;
  if (!dt) return;
  const uri = pathToFileUri(path);
  const name = basename(path);
  dt.setData("text/uri-list", uri);
  dt.setData("text/plain", uri);
  // DownloadURL = "<mime>:<filename>:<absolute url>". An empty mime lets the OS
  // sniff it; the receiver downloads/copies the file at `uri`.
  dt.setData("DownloadURL", `:${name}:${uri}`);
  dt.effectAllowed = "copy";
}

interface Props {
  /** Which built-in viewer to render with. */
  viewer: InternalViewer;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Owning project id (null in the root scope). */
  projectId: string | null;
  /** This viewer tab's key, so opened file links route to the SAME subwindow by
   *  default and drag-to-set-default can key its session-only override (#50). */
  tabKey?: string;
  /** Whether this pane is the active/visible tab of its group. Unused — the
   *  parent `.center-pane` already hides inactive panes via display:none — but
   *  accepted for call-site parity with the other pane components. */
  visible?: boolean;
  /** The subwindow (group) id hosting this pane, for proportional scroll-linking
   *  between two side-by-side viewer subwindows (see stores/scrollSync). Null/
   *  absent when the pane isn't in a syncable group; the sync hooks then no-op. */
  groupId?: string | null;
}

/**
 * Host for an in-app file viewer tab (TODO Group K #40). Unlike EmbedPane (which
 * opens the file in an external app), this renders the file's contents directly
 * inside the tab using a built-in viewer — independent of any external default
 * app:
 *   - "text"     → an editable code editor: a monospace textarea with a
 *                  line-number gutter, Tab/Shift+Tab indent, and Ctrl+S save back
 *                  to disk (Python, Rust, JSON, config files, …).
 *   - "markdown" → rendered HTML via renderMarkdown, with an Edit/Preview toggle
 *                  that lets you edit the source and save it back to disk.
 *   - "yaml"     → YAML **and JSON** (which is YAML's flow syntax): the same
 *                  editor with a Tree/Source toggle, where the tree is an editable
 *                  structure view (rename a key, retype a value, add a key or a
 *                  list item, reorder, delete). It splices the file's own text, so
 *                  comments and layout survive, each collection keeps the style it
 *                  is written in (block or flow), and both modes share one draft.
 *   - "image"    → the bytes wrapped in a Blob URL, shown in a zoomable/pannable
 *                  <img> (wheel to zoom at cursor, drag to pan, Fit / 1:1).
 *   - "pdf"      → rendered with pdf.js into a scrolling stack of page canvases
 *                  with a zoom toolbar. Every surface is ours, so the surround
 *                  and scrollbar follow the app theme (a dark viewer in dark
 *                  themes); the pages render as authored.
 *   - "tex"      → the LaTeX viewer: the same code editor as "text", plus an
 *                  in-tab compile + PDF preview split when a TeX engine is on
 *                  PATH; it degrades to exactly the "text" editor otherwise.
 * An "Open externally" button is always offered as a fallback.
 */
export function FileViewerPane({ viewer, path, projectId, tabKey, groupId }: Props) {
  const fileName = basename(path) || path;

  // Resolve whether these bytes are remote-native (host SFTP) or the local
  // mirror, and publish it to the tab strip so the Remote/Local badge rides on
  // this tab itself instead of costing a whole viewer header row (see the
  // fileSources store). Only remote (SSH) projects yield anything but "none";
  // the query is cheap (no file read) and re-runs when the path/scope changes.
  // The published entry is dropped when the viewer unmounts (tab closed).
  // `null` = not resolved yet; used by the disconnected-gate below to hold
  // rather than flash a red read error before we know the source.
  const [source, setSource] = useState<FileSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    fileSource(path, projectId)
      .then((s) => {
        if (cancelled) return;
        setSource(s);
        if (tabKey) useFileSourcesStore.getState().setSource(tabKey, s);
      })
      .catch(() => {
        if (cancelled) return;
        setSource("none");
        if (tabKey) useFileSourcesStore.getState().setSource(tabKey, "none");
      });
    return () => {
      cancelled = true;
      if (tabKey) useFileSourcesStore.getState().clearSource(tabKey);
    };
  }, [path, projectId, tabKey]);

  // Disconnected remote project: reading a remote-native (SFTP) file would block
  // on the dead pool and each nested viewer would flash its own red read error.
  // Instead show the SAME "Not connected" placeholder the remote shell uses, so
  // the message is unified across terminal and file tabs. Local-mirror files
  // (source "local") and local projects ("none") work offline and render as
  // usual; while the source is still unknown on a disconnected remote we hold.
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  const openConnectDialog = useConnectDialogStore((s) => s.open);
  const remoteDisconnected = !!project?.remote && sshState !== "connected";
  if (remoteDisconnected && source !== "local" && source !== "none") {
    return (
      <RemotePaneHold
        host={project?.remote?.host ?? ""}
        onConnect={() => { if (projectId) openConnectDialog(projectId); }}
      />
    );
  }

  const openExternally = () => {
    useWindowsStore
      .getState()
      .openFile(path, undefined, projectId, "right_file_tree")
      .catch((e) => console.error(e));
  };

  // Pick the concrete viewer, then publish this pane's owning project as the file
  // scope so every nested viewer/hook confines its file commands to this project
  // (and its box siblings) regardless of which project is globally current.
  let view: React.ReactNode;
  if (viewer === "gif") {
    // Animated GIFs get the frame-transport viewer (#gifviewer); the plain
    // image viewer remains its opt-out fallback (VIEWER_FALLBACK).
    view = <GifView path={path} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "image") {
    view = <ImageView path={path} fileName={fileName} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "pdf") {
    view = <PdfView path={path} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "markdown") {
    view = <MarkdownView path={path} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  } else if (viewer === "tex") {
    view = <TexView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "table") {
    view = <TableView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "notebook") {
    view = <NotebookView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "diff") {
    view = <DiffView path={path} projectId={projectId} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "syncdiff") {
    view = <DiffView path={path} projectId={projectId} mode="sync" onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "odt") {
    view = <OdtView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "media") {
    view = <MediaView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "html") {
    // HTML is now the editable base editor with a sandboxed live preview, keyed
    // to its own per-type prefs.
    view = <TextView path={path} onOpenExternally={openExternally} tabKey={tabKey} type="html" groupId={groupId} />;
  } else if (viewer === "sqlite") {
    view = <SqliteView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  } else if (viewer === "yaml") {
    // YAML is the same base editor, with the structure tree as its "preview" half
    // (#yaml) and its own per-type prefs.
    view = <TextView path={path} onOpenExternally={openExternally} tabKey={tabKey} type="yaml" groupId={groupId} />;
  } else {
    view = <TextView path={path} onOpenExternally={openExternally} tabKey={tabKey} groupId={groupId} />;
  }
  return (
    <FileScopeContext.Provider value={projectId}>
      <ViewerHeaderInfoContext.Provider value={{ path, projectId }}>
        {view}
      </ViewerHeaderInfoContext.Provider>
    </FileScopeContext.Provider>
  );
}

/** The file identity a `ViewerHeader` needs to offer file-scoped actions (the
 *  auto-sync toggle) without every sub-viewer threading these props through. Set
 *  by `FileViewerPane`; `null` outside a viewer pane. */
const ViewerHeaderInfoContext = createContext<{ path: string; projectId: string | null } | null>(
  null,
);

/**
 * Resolve `absPath` to the project-relative path the sync backend keys on, for a
 * REMOTE project only (auto-sync doesn't apply to local projects). Handles both a
 * local-mirror file (under the mirror root) and a remote-native file (under the
 * host `remote_path`). Returns `null` when the project isn't remote or the path
 * lies outside both roots (so the toggle simply hides).
 */
function autoSyncRel(
  project: ReturnType<typeof useProjectsStore.getState>["projects"][number] | undefined,
  absPath: string,
): string | null {
  if (!project?.remote) return null;
  const projectDir = resolveProjectDirectory(project);
  const mirrorRoot = resolveLocalMirror(project) ?? (projectDir ? `${projectDir}/mirror` : null);
  if (mirrorRoot) {
    const r = relFromAbs(mirrorRoot, absPath);
    if (r) return r;
  }
  const r2 = relFromAbs(project.remote.remote_path, absPath);
  return r2 || null;
}

/**
 * Auto-sync indicator + toggle for the viewer header. Shown only for a file that
 * belongs to a remote project (either its mirror copy or its host copy). Reflects
 * and flips `SyncEntry::auto_sync` via the sync store; disabled while the remote is
 * disconnected (the backend engine can't act until reconnected).
 */
function AutoSyncHeaderToggle({ path, projectId }: { path: string; projectId: string | null }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const rel = useMemo(() => autoSyncRel(project, path), [project, path]);
  const auto = useSyncStore((s) =>
    projectId && rel ? !!s.byProject[projectId]?.[rel]?.auto : false,
  );
  const setAuto = useSyncStore((s) => s.setAuto);
  const sshState = useRemoteStatusStore((s) => (projectId ? s.byProject[projectId]?.ssh : undefined));
  if (!project?.remote || !rel || !projectId) return null;
  const connected = sshState === "connected";
  return (
    <button
      type="button"
      className={`file-viewer-autosync${auto ? " on" : ""}`}
      title={
        !connected
          ? "Auto-sync (connect the remote to change)"
          : auto
            ? "Auto-syncing — click to stop"
            : "Auto-sync this file"
      }
      aria-label={auto ? "Stop auto-syncing this file" : "Auto-sync this file"}
      aria-pressed={auto}
      disabled={!connected}
      onClick={() => void setAuto(projectId, [rel], !auto, false)}
    >
      ⟳
    </button>
  );
}

/**
 * Open `resolved` (a linked file) following the #50 routing rules: prefer a
 * session-only drag-set override group, else the SAME subwindow/group as the
 * linking tab, else the focused group (addTab default). Re-activates an existing
 * viewer tab for the same file instead of opening a duplicate.
 */
export function openLinkedFile(
  linkingTabKey: string | undefined,
  linkingFileDir: string,
  resolved: { path: string; viewer: InternalViewer; label: string },
) {
  const store = useTabsStore.getState();
  const prior = store.tabs.find(
    (t) => t.kind === "embed" && t.viewer === resolved.viewer && t.embedPath === resolved.path,
  );
  if (prior) {
    store.setActive(prior.key);
    return;
  }
  const tab = {
    label: resolved.label,
    cmd: "",
    cwd: linkingFileDir,
    kind: "embed" as const,
    embedPath: resolved.path,
    viewer: resolved.viewer,
  };

  // 1. A session-only override set by dragging this link to another subwindow.
  const override =
    linkingTabKey != null
      ? useLinkRoutingStore.getState().getRoute(linkingTabKey, resolved.path)
      : null;
  // 2. Otherwise the SAME group the linking tab lives in.
  const sameGroup =
    linkingTabKey != null
      ? findGroupOfTab(store.layout, linkingTabKey)?.group.id ?? null
      : null;
  const targetGroup = override ?? sameGroup;

  if (targetGroup) {
    // splitWithNewTab with "center" adds into the target group without splitting,
    // and returns null if the group no longer exists (then we fall back).
    const created = store.splitWithNewTab(tab, targetGroup, "center");
    if (created) {
      store.setActive(created.key);
      return;
    }
  }
  // Fallback: focused group (addTab default).
  const entry = store.addTab(tab);
  store.setActive(entry.key);
}

/** Resolve a markdown local-file href (relative/absolute/`file:`) to an absolute
 *  path against the directory of the markdown file `mdPath`. Drops any
 *  `?query`/`#fragment`, percent-decodes, and normalises `.`/`..` segments. The
 *  result keeps `mdPath`'s separator style, so it is correct on Windows (native
 *  backslashes + drive letter) as well as Unix. Returns null for an empty target. */
function resolveLocalHref(mdPath: string, href: string): string | null {
  let h = href.trim().replace(/[?#].*$/, "");
  if (!h) return null;
  if (/^file:\/\//i.test(h)) {
    const decoded = fromFileUri(h);
    return decoded ? normalizePath(decoded) : null;
  }
  try { h = decodeURIComponent(h); } catch { /* keep the raw href */ }
  return resolvePath(dirname(mdPath), h);
}

/** MIME type for inlining a local image into the markdown preview as a Blob URL.
 *  Raster formats render even from a typeless blob (the webview content-sniffs
 *  the magic bytes), but SVG is XML text the browser will NOT sniff as an image —
 *  an `<img>` only renders it when the blob is explicitly `image/svg+xml`. That's
 *  why an SVG in a doc (e.g. README's "At a glance" map) showed blank. We set the
 *  type for every known extension so all inlined images carry a correct MIME. */
function imageMimeForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    default: return "";
  }
}

/** The built-in viewer for a bare path (no FileEntry handy), used to route a
 *  SyncTeX source target. Defaults to the plain text editor (e.g. `.sty`). */
export function viewerForPath(path: string): InternalViewer {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path,
    is_dir: false,
    size: 0,
    extension: ext,
    mime: null,
  };
  return internalViewerFor(entry) ?? "text";
}

/** Tauri event carrying a reverse-search jump across the main/detached window
 *  boundary (#42). Only the main window listens; see {@link jumpToSource}. */
const SOURCE_JUMP_EVENT = "editor-source-jump";
interface SourceJumpEnvelope {
  input: string;
  line: number;
  column: number;
}

/** True when this webview is the MAIN window (no `?detached=` param) — the one
 *  that owns the full tab layout and is the canonical place to open source files
 *  for reverse search. */
function isMainWindow(): boolean {
  try {
    return parseDetachedParam(window.location.search) === null;
  } catch {
    return true;
  }
}

/** Open/re-activate the source tab in THIS window and post the editor jump to its
 *  local editorJump store. The local half of {@link jumpToSource}. */
function applySourceJump(input: string, line: number, column: number) {
  const dir = dirname(input) || "/";
  const label = basename(input);
  openLinkedFile(undefined, dir, { path: input, viewer: viewerForPath(input), label });
  useEditorJumpStore.getState().requestJump(input, line, column);
}

/**
 * SyncTeX reverse search lands here: open (or re-activate) the source file's
 * editor tab and ask it to scroll to `line`/`column`. The editor
 * (`TexView`/`TextView`) for that path consumes the request via the editorJump
 * store, since the tab may already be open and won't remount.
 *
 * #42 cross-window: the PDF may be popped out into a detached window, either on
 * its own (source editor docked in the main window) or alongside the source in a
 * split view. Decide where to run the jump:
 *  - The source editor is already mounted in THIS window (e.g. a split PDF|TeX,
 *    possibly popped out) → just scroll it. This is the path a detached window
 *    must take, because its React-rendered tabs never populate `useTabsStore`,
 *    so a tab-store probe alone would wrongly report "not open" and delegate to
 *    the main window, where the editor isn't.
 *  - This window already has the source as a (possibly background) tab, or this
 *    IS the main window → open/focus it here.
 *  - Otherwise (detached window without the source) → broadcast to the main
 *    window, which owns the editor layout (it registers {@link listenSourceJump}).
 * `requestJump` itself broadcasts cross-window, so the scroll reaches the editor
 * wherever it is mounted regardless of which branch opens/focuses the tab.
 */
export function jumpToSource(input: string, line: number, column = 0) {
  if (hasMountedEditor(input)) {
    useEditorJumpStore.getState().requestJump(input, line, column);
    return;
  }
  const viewer = viewerForPath(input);
  const hasTab = useTabsStore
    .getState()
    .tabs.some((t) => t.kind === "embed" && t.viewer === viewer && t.embedPath === input);
  if (hasTab || isMainWindow()) {
    applySourceJump(input, line, column);
    return;
  }
  // Detached window without the source tab: ask the main window to handle it.
  try {
    emit(SOURCE_JUMP_EVENT, { input, line, column } satisfies SourceJumpEnvelope).catch(() => {});
  } catch {
    /* no Tauri event bus available */
  }
}

/**
 * MAIN window: listen for reverse-search jumps broadcast from a detached PDF
 * window and run them here (open/focus the source tab + scroll the caret).
 * Register once at startup; returns an unlisten. No-op outside Tauri. Detached
 * windows never register this — they either handle a jump locally (they own the
 * source tab) or delegate to the main window via {@link jumpToSource}.
 */
export async function listenSourceJump(): Promise<() => void> {
  try {
    return await listen<SourceJumpEnvelope>(SOURCE_JUMP_EVENT, (ev) => {
      const { input, line, column } = ev.payload;
      applySourceJump(input, line, column);
    });
  } catch {
    return () => {};
  }
}

export function ViewerHeader({
  onOpenExternally,
  children,
}: {
  onOpenExternally: () => void;
  children?: React.ReactNode;
}) {
  // No filename label: the tab already shows it. The spacer keeps the controls
  // and the open-externally icon pushed to the trailing edge. The remote/local
  // source badge no longer lives here — it rides on the tab itself (see
  // TabBar's tab-source badge), so it costs no header row. The auto-sync toggle
  // (remote projects only) rides in from context so no sub-viewer has to pass it.
  const info = useContext(ViewerHeaderInfoContext);
  return (
    <div className="file-viewer-header">
      <div className="file-viewer-header-spacer" aria-hidden="true" />
      {children}
      {info && <AutoSyncHeaderToggle path={info.path} projectId={info.projectId} />}
      <button
        className="file-viewer-open-external"
        onClick={onOpenExternally}
        title="Open in external app"
        aria-label="Open in external app"
      >
        ↗
      </button>
    </div>
  );
}

// ── Undo/redo history (#46) ──────────────────────────────────────────────────

/** Edit-history state: a stack of past values, the present value, and a redo
 *  stack of future values. Pure so it can be unit-tested without React. */
/** Imperative editing surface exposed by {@link CodeEditor} via `editorApiRef`,
 *  letting a toolbar transform the live value+selection. */
export interface EditorApi {
  /** Run `fn` over the current value and selection `[start, end)`, commit the
   *  result through the editor's normal edit path, and restore the returned
   *  selection. */
  applyEdit: (fn: (value: string, start: number, end: number) => EditResult) => void;
}

export interface EditHistory {
  past: string[];
  present: string;
  future: string[];
}

export type EditAction =
  | { type: "set"; value: string; coalesce?: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: string };

/** Cap so a long editing session can't grow the undo stack without bound. */
const HISTORY_LIMIT = 200;

/**
 * Pure reducer for the editor undo/redo history (#46). A "set" pushes the prior
 * present onto `past` and clears `future`, unless `coalesce` is true (rapid
 * keystrokes) — then it replaces the present in place so a burst of typing
 * collapses into one undo step. "reset" seeds a fresh baseline (file (re)load)
 * with empty stacks.
 */
export function editHistoryReducer(state: EditHistory, action: EditAction): EditHistory {
  switch (action.type) {
    case "set": {
      if (action.value === state.present) return state;
      if (action.coalesce) {
        return { ...state, present: action.value, future: [] };
      }
      const past = [...state.past, state.present];
      if (past.length > HISTORY_LIMIT) past.shift();
      return { past, present: action.value, future: [] };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: prev,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      };
    }
    case "reset":
      return { past: [], present: action.value, future: [] };
    default:
      return state;
  }
}

// Coalesce keystrokes within this window into a single undo step.
const COALESCE_MS = 400;

// #45 automatic autocomplete: idle time after the last keystroke before a
// suggestion is requested for the focused editor. Long enough not to fire on
// every keystroke, short enough to feel responsive.
const AUTO_AC_DEBOUNCE_MS = 600;

// #45 follow-up grammar check: idle time after the last keystroke before the
// whole draft is re-checked. Longer than the autocomplete debounce — a full-
// document check is heavier, and grammar marks needn't track every keystroke.
const GRAMMAR_DEBOUNCE_MS = 2500;

// #45 completion-length modes. Cycle order for the live Shift+Tab toggle (while
// a ghost suggestion is showing) and human labels for the status line / settings
// dropdown. Kept in sync with the Rust `CompletionMode`.
const AC_MODES: AutocompleteMode[] = ["sentence", "block", "scope"];
const AC_MODE_LABELS: Record<AutocompleteMode, string> = {
  sentence: "Sentence",
  block: "Block",
  scope: "Scope",
};
/** Next mode in the cycle (wraps), for the live Shift+Tab toggle. */
function nextAcMode(m: AutocompleteMode): AutocompleteMode {
  return AC_MODES[(AC_MODES.indexOf(m) + 1) % AC_MODES.length];
}

/** React wrapper over `editHistoryReducer` exposing `value`, a coalescing
 *  `setValue`, `undo`/`redo` (+ availability), and `reset`. */
function useEditHistory(initial: string) {
  const [hist, dispatch] = useReducer(editHistoryReducer, {
    past: [],
    present: initial,
    future: [],
  } as EditHistory);
  const lastEditAt = useRef(0);

  const setValue = useCallback((value: string) => {
    const now = Date.now();
    const coalesce = now - lastEditAt.current < COALESCE_MS;
    lastEditAt.current = now;
    dispatch({ type: "set", value, coalesce });
  }, []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const reset = useCallback((value: string) => {
    lastEditAt.current = 0;
    dispatch({ type: "reset", value });
  }, []);

  return {
    value: hist.present,
    setValue,
    undo,
    redo,
    reset,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}

// Poll interval for the diff-aware auto-reload (#43), ~1.5s.
const RELOAD_POLL_MS = 1500;

/**
 * Editable-file state shared by the editable viewers — the code and markdown
 * editors, and the table viewer, whose cell edits are splices into this same
 * text draft (see `lib/viewers/table.ts`): loads `path`, keeps a `draft` against
 * the last-known-on-disk `baseline` (so "dirty" is just draft !== baseline), and
 * writes the draft back via write_file_text — re-seeding the baseline on success
 * so the dirty flag clears without re-reading the file.
 *
 * Adds (Group M):
 *  - #46 undo/redo: the draft is backed by `useEditHistory`; `undo`/`redo` are
 *    surfaced for keybindings + toolbar buttons.
 *  - #47 autosave: when `settings.autosave` is on, a dirty buffer is saved on
 *    every change (each keystroke).
 *  - #43 diff-aware reload: polls `file_mtime`; when the file changes on disk it
 *    silently re-reads into a clean buffer, or surfaces a non-destructive banner
 *    when the buffer is dirty (Reload / Keep mine) — never clobbering edits.
 */
export function useEditableFile(path: string) {
  const scope = useFileScope();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True when disk changed under a dirty buffer; the viewer shows a banner.
  const [externalChange, setExternalChange] = useState(false);

  const { value: draft, setValue: setDraftValue, undo, redo, reset, canUndo, canRedo } =
    useEditHistory("");

  // mtime we last saw on disk, to detect external writes (#43). Our own saves
  // bump it so they don't trip the watcher.
  const lastMtime = useRef<number | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef<string | null>(baseline);
  baselineRef.current = baseline;

  // Autosave is ON by default; only an explicit `autosave: false` disables it.
  const autosave = useSettingsStore((s) => s.settings?.autosave !== false);

  // setDraft seeds history when typing; reset is used for (re)loads from disk.
  const setDraft = setDraftValue;

  const seedFromDisk = useCallback(
    (text: string) => {
      reset(text);
      setBaseline(text);
      setContent(text);
      setExternalChange(false);
    },
    [reset],
  );

  // Initial load + mtime baseline.
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setBaseline(null);
    setExternalChange(false);
    lastMtime.current = null;
    readFileText(path, scope)
      .then((text) => {
        if (cancelled) return;
        seedFromDisk(text);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope, seedFromDisk]);

  const loaded = content != null;
  const isDirty = loaded && baseline != null && draft !== baseline;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const save = useCallback(async () => {
    if (!isDirtyRef.current || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const toSave = draftRef.current;
      await writeFileText(path, toSave, scope);
      setBaseline(toSave);
      setExternalChange(false);
      // Our own write advances mtime; refresh so the poller doesn't see it as an
      // external change.
      try {
        lastMtime.current = await fileMtime(path, scope);
      } catch {
        /* mtime refresh is best-effort */
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [saving, path, scope]);

  // #47 autosave: when the setting is on, write the buffer to disk on every
  // change — each keystroke as well as the moment autosave is toggled on with
  // unsaved edits. `save()` no-ops when the buffer is clean or already saving.
  useEffect(() => {
    if (autosave && isDirty) void save();
  }, [autosave, isDirty, draft, save]);

  // #43 diff-aware reload: poll mtime; on an external advance, re-read into a
  // clean buffer silently, or flag a banner if the buffer is dirty.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const id = setInterval(() => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null) return;
          if (m <= lastMtime.current) return;
          lastMtime.current = m;
          if (isDirtyRef.current) {
            // Don't clobber unsaved edits — surface a reconcile banner.
            setExternalChange(true);
            return;
          }
          // Clean buffer → silently re-read + reseed baseline/draft.
          readFileText(path, scope)
            .then((text) => { if (!cancelled) seedFromDisk(text); })
            .catch(() => {});
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, loaded, seedFromDisk]);

  // Banner actions (#43): take the disk version, or keep mine (dismiss banner +
  // adopt current mtime so the next external change re-triggers).
  const reloadFromDisk = useCallback(() => {
    readFileText(path, scope)
      .then((text) => seedFromDisk(text))
      .catch((e) => setSaveError(String(e)));
  }, [path, scope, seedFromDisk]);
  const keepMine = useCallback(() => setExternalChange(false), []);

  return {
    content, error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo,
    externalChange, reloadFromDisk, keepMine,
  };
}

/** The non-destructive external-change banner (#43). */
export function ExternalChangeBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="file-viewer-reload-banner" role="alert">
      <span>This file changed on disk and you have unsaved edits.</span>
      <button className="file-viewer-reload-btn" onClick={onReload}>Reload</button>
      <button className="file-viewer-reload-btn" onClick={onKeep}>Keep mine</button>
    </div>
  );
}

const INDENT = "    "; // 4 spaces — what Tab inserts and Shift+Tab strips.

/** Apply Tab / Shift+Tab indentation to a code textarea, preserving selection.
 *  Returns the next value + selection, or null to let the key fall through. */
export function applyIndent(
  el: HTMLTextAreaElement,
  outdent: boolean,
): { value: string; selStart: number; selEnd: number } | null {
  const { value, selectionStart: start, selectionEnd: end } = el;
  const multiLine = value.slice(start, end).includes("\n");

  // Plain Tab with no multi-line selection → insert one indent at the caret.
  if (!outdent && !multiLine) {
    const value2 = value.slice(0, start) + INDENT + value.slice(end);
    const caret = start + INDENT.length;
    return { value: value2, selStart: caret, selEnd: caret };
  }

  // Otherwise operate on every line the selection touches.
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const next = lines
    .map((line, i) => {
      if (outdent) {
        // Strip up to one indent's worth of leading whitespace (a full INDENT,
        // else whatever leading spaces/tabs exist, capped at INDENT width).
        const lead = line.match(/^[ \t]+/)?.[0].length ?? 0;
        const strip = line.startsWith(INDENT)
          ? INDENT.length
          : Math.min(lead, INDENT.length);
        if (strip > 0) {
          if (i === 0) firstDelta = -strip;
          totalDelta -= strip;
          return line.slice(strip);
        }
        return line;
      }
      if (i === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    })
    .join("\n");

  const value2 = value.slice(0, lineStart) + next + value.slice(end);
  return {
    value: value2,
    selStart: Math.max(lineStart, start + firstDelta),
    selEnd: end + totalDelta,
  };
}

/**
 * The reusable code-editor body: a monospace textarea with a scroll-synced
 * line-number gutter, Tab/Shift+Tab indentation, and Ctrl/Cmd+S to save. Shared
 * by the plain-text viewer ("text") and the LaTeX viewer's source pane ("tex")
 * so the indent/scroll/save behaviour stays identical between them. Renders the
 * load/error states itself; the caller wires it to a `useEditableFile` instance.
 */
export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Read-only sibling of `useEditableFile` for the table/notebook/diff viewers
 * (none of which edit on disk). Loads the file once via `read_file_text` and
 * polls `file_mtime`, silently re-reading when the file changes underneath — the
 * same load/refresh path `useEditableFile` uses, minus all the draft/undo/save
 * machinery. Returns the raw text (or null while loading) and an error string.
 */
export function useReadonlyFile(path: string) {
  const scope = useFileScope();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastMtime = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    lastMtime.current = null;
    readFileText(path, scope)
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope]);

  // Diff-aware reload: poll mtime and silently re-read on an external advance.
  useEffect(() => {
    if (content == null) return;
    let cancelled = false;
    const id = setInterval(() => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          readFileText(path, scope)
            .then((text) => { if (!cancelled) setContent(text); })
            .catch(() => {});
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope, content]);

  return { content, error, loaded: content != null };
}

/**
 * Build a transparent decoration layer (#49) where the `ranges` are wrapped in
 * `<span class="file-link">` so they read as clickable (dotted underline). The
 * surrounding text is escaped and emitted plain (transparent), so only the link
 * spans paint. SECURITY: every run of source text is HTML-escaped before output.
 */
export function decorateLinkRanges(source: string, ranges: { start: number; end: number }[]): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    out += `<span class="file-link">${escapeHtmlText(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Find every (non-overlapping) occurrence of `query` in `text` as a
 * `{start, end}` offset range (#67 editor search). A plain substring search;
 * `caseSensitive` toggles a case-fold. An empty query yields no matches.
 * Exported for unit testing.
 */
export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

/**
 * Build the transparent search-highlight overlay (#67): the `matches` ranges are
 * wrapped in `<span class="file-viewer-search-match">` (the `current` one also
 * carries `current`), the rest emitted plain so only the match spans paint a
 * background. SECURITY: every run of source text is HTML-escaped before output —
 * mirrors `decorateLinkRanges`.
 */
export function decorateSearchRanges(
  source: string,
  matches: { start: number; end: number }[],
  current: number,
): string {
  if (matches.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  matches.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    const cls = i === current ? "file-viewer-search-match current" : "file-viewer-search-match";
    out += `<span class="${cls}">${escapeHtmlText(source.slice(r.start, r.end))}</span>`;
    pos = r.end;
  });
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * The `{start, end}` (in `next` coordinates) of the run of text that differs
 * between `prev` and `next`, found by trimming the common prefix and suffix.
 * Used to tint the most-recent edit. Returns `null` when nothing was inserted
 * or replaced — i.e. equal strings, or a pure deletion (whose changed range is
 * zero-width in `next`, so there is nothing to paint).
 */
export function diffRange(prev: string, next: string): { start: number; end: number } | null {
  const span = editSpan(prev, next);
  return span && span.endNext > span.start ? { start: span.start, end: span.endNext } : null;
}

/**
 * The full span of an edit between `prev` and `next`: `start` is the common
 * prefix length, `endPrev`/`endNext` are where the differing run ends in each
 * string (so `prev.slice(start, endPrev)` was replaced by `next.slice(start,
 * endNext)`). Unlike `diffRange` this is reported for deletions too (where
 * `endNext === start`), since the change-tint trail must still re-map older
 * ranges through a deletion. Returns `null` only for equal strings. Pure —
 * exported for tests.
 */
export function editSpan(
  prev: string,
  next: string,
): { start: number; endPrev: number; endNext: number } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/** How many recent edit runs the change-tint trail keeps (and how many colour
 *  tiers `themes.css` defines, `.tier-0` … `.tier-(N-1)`). */
export const CHANGE_TIERS = 18;
/** Idle delay before the trail retires its oldest run, in ms — once typing stops
 *  the trail fades a tier at a time over CHANGE_TIERS × this. */
const CHANGE_DECAY_MS = 1800;

/** How long a red strike-through ghost of just-deleted text lingers before it
 *  fades out and is dropped, in ms. Must match the `fv-delete-fade` animation
 *  duration in `themes.css` — the CSS drives the visual fade, this drives the
 *  state cleanup, and they retire the ghost together. */
export const DELETE_GHOST_MS = 2600;

/** A run of text that was just removed from the draft, kept around briefly so it
 *  can be shown struck-through in red at the spot it vanished from before fading
 *  out. `pos` is the anchor in *current* draft coordinates (re-mapped through
 *  later edits like a change range); `text` is the removed characters; `born` is
 *  the `Date.now()` clock the fade animation is offset against so it keeps
 *  elapsing correctly even as the overlay is rebuilt on each keystroke. */
export interface DeleteGhost {
  id: number;
  pos: number;
  text: string;
  born: number;
}

/**
 * Build the transparent deletion overlay: the removed text of each ghost is
 * *injected* back into the source at its anchor, wrapped in
 * `<span class="file-viewer-delete-mark">`, so it paints a red strike-through
 * (over an opaque background that masks the live text it now overlays) right
 * where it was deleted. The surrounding source is emitted plain/transparent —
 * like the autocomplete ghost, this layer intentionally reflows: only the
 * injected marks are meant to show. Each mark's `animation-delay` is set to the
 * negative elapsed time so its fade resumes at the right point across rebuilds.
 * SECURITY: every run (source and injected text) is HTML-escaped.
 */
export function decorateDeleteRanges(
  source: string,
  ghosts: DeleteGhost[],
  now: number,
): string {
  const sorted = ghosts
    .map((g) => ({ ...g, pos: Math.max(0, Math.min(g.pos, source.length)) }))
    .sort((a, b) => a.pos - b.pos || a.born - b.born);
  let out = "";
  let pos = 0;
  for (const g of sorted) {
    out += escapeHtmlText(source.slice(pos, g.pos));
    pos = g.pos;
    const elapsed = Math.max(0, now - g.born);
    out += `<span class="file-viewer-delete-mark" style="animation-delay:-${elapsed}ms">${escapeHtmlText(
      g.text,
    )}</span>`;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/** The text a deletion ghost should strike through for a removed run: the run
 *  with surrounding whitespace trimmed off, or null when it was whitespace-only
 *  (nothing visible to cross out — a lingering space-only strike would just read
 *  as invisible text). Pure — exported for tests. */
export function deletionGhostText(removed: string): string | null {
  const trimmed = removed.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One run of recently typed text in the change-tint trail. `tier` is its age:
 *  0 is the newest edit, higher tiers are progressively older (and fainter). */
export interface ChangeRange {
  start: number;
  end: number;
  tier: number;
}

/**
 * Re-map an existing change range through a new edit so it keeps pointing at the
 * same characters: untouched if it sits entirely before the edit, shifted by the
 * length delta if entirely after, and dropped (returns `null`) if it overlaps the
 * edited region (its text was overwritten). Pure — exported for tests.
 */
export function remapChangeRange(
  range: { start: number; end: number },
  span: { start: number; endPrev: number; endNext: number },
): { start: number; end: number } | null {
  const delta = span.endNext - span.endPrev;
  if (range.end <= span.start) return range;
  if (range.start >= span.endPrev) {
    return { start: range.start + delta, end: range.end + delta };
  }
  return null;
}

/**
 * Build the transparent change-tint overlay: each recent edit range is wrapped in
 * `<span class="file-viewer-change-mark tier-N">` so it paints its age-graded
 * tint (tier 0 newest), the rest emitted plain. Ranges must be non-overlapping;
 * they are sorted left-to-right here. SECURITY: every run is HTML-escaped —
 * mirrors `decorateSearchRanges`.
 */
export function decorateChangeRanges(
  source: string,
  ranges: ChangeRange[],
): string {
  const clamped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, source.length)),
      end: Math.max(0, Math.min(r.end, source.length)),
      tier: r.tier,
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (clamped.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  for (const r of clamped) {
    if (r.start < pos) continue; // defensive: skip any residual overlap
    out += escapeHtmlText(source.slice(pos, r.start));
    out += `<span class="file-viewer-change-mark tier-${r.tier}">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  }
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/** A grammar issue resolved to a concrete `{start, end}` character range in the
 *  current draft, carrying its originating issue for the tooltip / apply-fix. */
export interface GrammarRange {
  start: number;
  end: number;
  issue: GrammarIssue;
}

/**
 * Resolve each model-reported grammar issue to a character range in `text`. The
 * model reports the offending substring `bad` plus its 1-based `line`; we search
 * that line first (so duplicates of a word map to the right occurrence), then
 * fall back to the whole document, so a small edit since the check doesn't drop
 * every mark. Issues resolve in order with a per-line cursor, so several errors
 * on one line each map to their own occurrence. Unlocatable issues are skipped;
 * the result is sorted by start with overlaps pruned so the decorator's
 * left-to-right walk stays clean. Pure — exported for tests.
 */
export function resolveGrammarRanges(text: string, issues: GrammarIssue[]): GrammarRange[] {
  if (issues.length === 0) return [];
  // 0-based offset where each 1-based line begins (lineStarts[n-1] = line n).
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  // Per-line search cursor so repeated errors on a line advance past each other.
  const lineCursor = new Map<number, number>();
  const out: GrammarRange[] = [];
  for (const issue of issues) {
    const bad = issue.bad;
    if (!bad) continue;
    let start = -1;
    const li = issue.line - 1;
    if (li >= 0 && li < lineStarts.length) {
      const lineStart = lineStarts[li];
      const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] : text.length;
      const from = Math.max(lineStart, lineCursor.get(li) ?? lineStart);
      const idx = text.indexOf(bad, from);
      if (idx >= 0 && idx < lineEnd) {
        start = idx;
        lineCursor.set(li, idx + bad.length);
      }
    }
    if (start < 0) {
      // The reported line drifted since the check — locate it anywhere.
      const idx = text.indexOf(bad);
      if (idx >= 0) start = idx;
    }
    if (start < 0) continue;
    out.push({ start, end: start + bad.length, issue });
  }
  out.sort((a, b) => a.start - b.start);
  const pruned: GrammarRange[] = [];
  let lastEnd = -1;
  for (const r of out) {
    if (r.start < lastEnd) continue; // drop overlaps
    pruned.push(r);
    lastEnd = r.end;
  }
  return pruned;
}

/**
 * Build the transparent grammar overlay: each range is wrapped in a
 * `<span class="file-viewer-grammar-mark cat-<category>" data-gi="<i>">` so it
 * paints a coloured wavy underline (colour by category) while the surrounding
 * text stays plain/transparent. The `data-gi` index ties a span back to its
 * `ranges` entry for hover hit-testing. SECURITY: every run of source text is
 * HTML-escaped before output — mirrors `decorateSearchRanges`.
 */
export function decorateGrammarRanges(source: string, ranges: GrammarRange[]): string {
  if (ranges.length === 0) return escapeHtmlText(source);
  let out = "";
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start < pos || r.start >= r.end) return; // skip overlaps / empties
    out += escapeHtmlText(source.slice(pos, r.start));
    const cat =
      r.issue.category === "spelling" || r.issue.category === "style"
        ? r.issue.category
        : "grammar";
    out += `<span class="file-viewer-grammar-mark cat-${cat}" data-gi="${i}">${escapeHtmlText(
      source.slice(r.start, r.end),
    )}</span>`;
    pos = r.end;
  });
  out += escapeHtmlText(source.slice(pos));
  return out;
}

/**
 * Replace each `{start, end}` range in `text` with `replacement`, returning the
 * new string (#67 find-and-replace). Ranges are applied left-to-right; any that
 * overlap an already-consumed range (or are empty) are skipped, mirroring the
 * non-overlapping match set `findMatches` produces. Pure — exported for testing.
 */
export function applyReplacements(
  text: string,
  ranges: { start: number; end: number }[],
  replacement: string,
): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || r.start >= r.end) continue;
    out += text.slice(pos, r.start) + replacement;
    pos = r.end;
  }
  out += text.slice(pos);
  return out;
}

/** Live device-pixel ratio, updated when it changes (window moved between
 *  monitors, display scale changed, browser zoom). Used to snap the editor's
 *  line-height to whole device pixels — see `snapToDevicePx`. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [dpr]);
  return dpr;
}

/**
 * Snap a CSS-pixel length to a whole number of device pixels at `dpr`.
 *
 * The code editor stacks a transparent <textarea> (which owns the caret) over a
 * syntax-highlighted <pre>. WebKitGTK lays the textarea's lines out as
 * whole-device-pixel line boxes (height `round(lineHeight·dpr)` each, stacked),
 * but positions the <pre>'s lines at the exact fractional multiple
 * (`round(n·lineHeight·dpr)`). Under a fractional display scale those differ by
 * a fraction of a pixel per line and accumulate — over a long file (hundreds of
 * lines) the caret drifts a full line above the coloured text by the bottom.
 * Making `lineHeight·dpr` a whole number means both layouts land on the same
 * grid, so the per-line advance is identical and nothing accumulates. A no-op at
 * an integer dpr (e.g. 1.0 or 2.0), where the drift never appeared.
 */
export function snapToDevicePx(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr) / dpr;
}

/**
 * Viewport coordinates of the caret at character `pos` in a textarea, used to
 * anchor the `\ref`/`\cite` completion dropdown right under the typed key. Uses
 * the standard hidden-mirror technique: a div copies the textarea's box/text
 * metrics, holds the text up to `pos`, and a trailing marker span's offset gives
 * the caret position; the textarea's own scroll and screen rect map it to the
 * viewport. Returns the line height too so the caller can drop below the line.
 */
function textareaCaretViewportRect(
  ta: HTMLTextAreaElement,
  pos: number,
): { left: number; top: number; height: number } {
  const rect = ta.getBoundingClientRect();
  const style = getComputedStyle(ta);
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
  const div = document.createElement("div");
  const copy = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom",
    "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle",
    "fontVariant", "letterSpacing", "wordSpacing", "lineHeight", "tabSize",
    "textIndent", "textTransform",
  ] as const;
  for (const p of copy) div.style[p as never] = style[p as never];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = ta.wrap === "off" ? "pre" : "pre-wrap";
  div.style.overflowWrap = "anywhere";
  div.style.overflow = "hidden";
  div.style.height = "auto";
  div.textContent = ta.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = ta.value.slice(pos) || ".";
  div.appendChild(marker);
  document.body.appendChild(div);
  const top = rect.top + marker.offsetTop - ta.scrollTop;
  const left = rect.left + marker.offsetLeft - ta.scrollLeft;
  document.body.removeChild(div);
  return { left, top, height: lh };
}

/** Keys that, typed immediately after an accepted completion, replace the
 *  auto-inserted trailing space (closing punctuation reads better tight). */
const NO_SPACE_BEFORE = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}"]);

/** Bare modifier presses, ignored by the smart-space handler so that e.g. the
 *  Shift held to type `?` doesn't prematurely commit the space. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** One row of the `\ref`/`\cite` completion dropdown. */
interface TexComplItem {
  value: string;
  detail?: string;
}

/** Compact one-line description of a bib entry for the dropdown's second column:
 *  author (first surname et al.) and year, falling back to the title. */
function citeDetail(e: { title?: string; author?: string; year?: string }): string | undefined {
  const bits: string[] = [];
  if (e.author) {
    const first = e.author.split(/\s+and\s+/i)[0].trim();
    const surname = first.includes(",") ? first.split(",")[0] : first.split(/\s+/).pop() || first;
    bits.push(e.author.includes(" and ") ? `${surname} et al.` : surname);
  }
  if (e.year) bits.push(e.year);
  const head = bits.join(" ");
  if (head && e.title) return `${head} — ${e.title}`;
  return head || e.title;
}

function CodeEditor({
  error,
  draft,
  setDraft,
  loaded,
  save,
  path,
  onFollowLink,
  linkRanges,
  undo,
  redo,
  autocomplete,
  grammarCheck,
  texCompletions,
  fontSize,
  lineHeight,
  incFont,
  decFont,
  resetFont,
  wrap,
  gotoLine,
  onGotoApplied,
  onCaretChange,
  caretApiRef,
  editorApiRef,
  showBlame,
  blame,
  breakpoints,
  onToggleBreakpoint,
  initialScrollTop,
  onScrollPersist,
  groupId,
}: {
  error: string | null;
  draft: string;
  setDraft: (value: string) => void;
  loaded: boolean;
  save: () => void;
  /** File path, used to pick the syntax-highlighting language by extension. */
  path: string;
  /** When set, Ctrl/Cmd+Click resolves the reference at the clicked caret index
   *  and opens it (the LaTeX viewer wires this to `\input{…}` follow). */
  onFollowLink?: (caret: number) => void;
  /** SyncTeX reverse-search target: move the caret to (1-based) `line`/`column`
   *  (`column` 0 = line start) and scroll it into view whenever `nonce` changes. */
  gotoLine?: { line: number; column?: number; nonce: number };
  /** Called once a `gotoLine` request has been applied, so the caller can clear
   *  it (consume the editorJump request). */
  onGotoApplied?: () => void;
  /** Reports the current caret offset (after clicks / key navigation), so the
   *  LaTeX viewer can run SyncTeX forward search from it on compile. */
  onCaretChange?: (offset: number) => void;
  /** When set, receives a getter for the textarea's *live* caret offset (or
   *  `null` if the editor isn't mounted/available). The LaTeX viewer reads this
   *  synchronously at compile time so forward search uses the real cursor even if
   *  no caret event fired this session — `onCaretChange`/its snapshot can be a
   *  stale 0 (e.g. the editor was never focused, or a WebKitGTK blur reset it). */
  caretApiRef?: React.MutableRefObject<(() => number | null) | null>;
  /** When set, receives an imperative editing API so a toolbar (the Markdown
   *  viewer's bold/italic/heading/… controls) can transform the current
   *  value+selection; edits commit through the normal path so undo/redo and the
   *  syntax overlay stay consistent. Cleared on unmount. */
  editorApiRef?: React.MutableRefObject<EditorApi | null>;
  /** When set, returns the source ranges to decorate as clickable file links
   *  (#49). Currently the LaTeX viewer's `\input{…}`/`\includegraphics{…}` args. */
  linkRanges?: (source: string) => { start: number; end: number }[];
  /** Undo/redo handlers (#46) — wired to Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
  undo?: () => void;
  redo?: () => void;
  /** Opt-in local autocomplete config (#45). Disabled when undefined/off.
   *  `preferred` is the user's active local model (🧠 menu); the completion runs
   *  against whichever model is *currently loaded* in Ollama memory at trigger
   *  time, preferring `preferred` when it is among the loaded set. */
  autocomplete?: { enabled: boolean; preferred?: string; mode?: AutocompleteMode };
  /** Opt-in local grammar/spelling check (#45 follow-up). When enabled, the whole
   *  draft is checked against the currently-loaded local model after an idle
   *  pause; issues are underlined (colour by category) with a hover tooltip and
   *  one-click fix. `preferred` is the user's active local model (🧠 menu). */
  grammarCheck?: { enabled: boolean; preferred?: string };
  /** Opt-in `\ref`/`\cite` key completion (LaTeX viewer only). When supplied, a
   *  dropdown of `\label` keys (refs) or `.bib` entry keys (cites) appears while
   *  typing inside a recognised command's braces; Enter/Tab accepts. */
  texCompletions?: TexCompletions;
  /** Editor font metrics (text-size control). Default 12px / 18px when unset. */
  fontSize?: number;
  lineHeight?: number;
  /** Text-size handlers, wired to Ctrl +/− and Ctrl+0. */
  incFont?: () => void;
  decFont?: () => void;
  resetFont?: () => void;
  /** Soft-wrap long lines to the editor width instead of scrolling horizontally
   *  (used by the LaTeX viewer, whose prose lines run wide). The highlight/link/
   *  ghost overlays wrap in lockstep via the `is-wrapped` class. */
  wrap?: boolean;
  /** Git-blame overlay (#blame). When `showBlame` is set, a per-line blame column
   *  is painted in the gutter (scroll-locked with the line numbers) and the
   *  caret's line gets a faint inline attribution; hovering a blame cell shows a
   *  hovercard. `blame` maps 1-based line numbers to their attribution. */
  showBlame?: boolean;
  blame?: Map<number, BlameLine>;
  /** Debug breakpoints (#py), as 1-based line numbers. When `onToggleBreakpoint`
   *  is wired the gutter becomes interactive: each line number is a click target
   *  that toggles a breakpoint, and a breakpointed line paints a red dot. Only the
   *  Python editor supplies these; every other file type gets the inert,
   *  aria-hidden gutter it had before. */
  breakpoints?: ReadonlySet<number>;
  onToggleBreakpoint?: (line: number) => void;
  /** Persisted vertical scroll (px) to restore once the file loads, so reopening
   *  it (or an Eldrun restart) lands the reader where they left off (#viewerpos).
   *  Applied once on first load; user scrolling thereafter reports via
   *  `onScrollPersist`. */
  initialScrollTop?: number;
  /** Called (throttled) with the textarea's `scrollTop` as the reader scrolls, so
   *  the position can be persisted. */
  onScrollPersist?: (scrollTop: number) => void;
  /** When set, the subwindow (group) id hosting this editor, so its scroll is
   *  proportionally linked to a side-by-side viewer subwindow (scrollSync). */
  groupId?: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Proportional scroll-link to a paired subwindow (no-op unless linked).
  const reportScrollSync = useScrollSync(groupId, textareaRef);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const blameInnerRef = useRef<HTMLDivElement>(null);
  const blameInlineRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const linkLayerRef = useRef<HTMLPreElement>(null);
  const searchLayerRef = useRef<HTMLPreElement>(null);
  const changeLayerRef = useRef<HTMLPreElement>(null);
  const deleteLayerRef = useRef<HTMLPreElement>(null);
  const grammarLayerRef = useRef<HTMLPreElement>(null);
  const ghostRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLPreElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Link affordances over a recognised link (#49), only when `onFollowLink` is
  // wired (the LaTeX source editor):
  //  - `linkHover` shows the pointer cursor, but ONLY while the follow modifier is
  //    held, so the editor doesn't read as clickable the rest of the time.
  //  - `linkTip` anchors a "Ctrl+Click to open" hint, shown on plain hover (no
  //    modifier) so the shortcut is discoverable.
  const [linkHover, setLinkHover] = useState(false);
  const [linkTip, setLinkTip] = useState<{ left: number; top: number } | null>(null);
  // Last pointer position, so pressing/releasing the modifier while already
  // hovering a link (no mouse move) can still update the cursor.
  const lastMouse = useRef<{ x: number; y: number } | null>(null);

  // Ctrl/Cmd+wheel resizes the font. Bound non-passively (see useNonPassiveWheel)
  // so it never falls through to native scrolling.
  const wheelRef = useNonPassiveWheel((e) => onCtrlWheelFont(e, incFont, decFont));

  // Resolve the link affordances for the screen point `x,y`. The link layer is
  // scroll-synced to sit exactly over the textarea text, so its `.file-link` span
  // rects are the on-screen link hit boxes — no glyph metrics needed.
  const updateLinkHover = useCallback(
    (x: number, y: number, mod: boolean) => {
      const layer = linkLayerRef.current;
      if (!onFollowLink || !layer) {
        setLinkHover(false);
        setLinkTip(null);
        return;
      }
      let hit: DOMRect | null = null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-link")) {
        const r = span.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          hit = r;
          break;
        }
      }
      setLinkHover(hit != null && mod);
      setLinkTip(hit ? { left: hit.left, top: hit.top } : null);
    },
    [onFollowLink],
  );

  // #45 autocomplete: a pending ghost-text suggestion + the caret it applies at.
  const [suggestion, setSuggestion] = useState<{ text: string; at: number } | null>(null);
  // A short status shown to the user when a completion is in flight, returns
  // nothing, or can't run (e.g. no local model loaded) — otherwise the feature
  // fails silently and reads as broken. A trailing "…" marks a transient
  // in-flight message; final messages auto-dismiss (see the effect below).
  const [acStatus, setAcStatus] = useState<string | null>(null);
  const acAbort = useRef<AbortController | null>(null);
  // #45 live completion-length mode: starts from the per-type default and is
  // cycled in-editor with Shift+Tab while a suggestion is showing. Re-seeded if
  // the per-type default changes (e.g. the user picks a new default in settings).
  const [acMode, setAcMode] = useState<AutocompleteMode>(autocomplete?.mode ?? "sentence");
  useEffect(() => {
    setAcMode(autocomplete?.mode ?? "sentence");
  }, [autocomplete?.mode]);

  // Auto-dismiss a finished autocomplete status after a few seconds; keep the
  // in-flight "…" message until the request resolves.
  useEffect(() => {
    if (!acStatus || acStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setAcStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [acStatus]);

  // #45 context files: extra project files the user attaches as read-only context
  // for completion. Per-editor (not persisted); each entry caches the file's text
  // at attach time so requests don't re-read disk on every keystroke. `acPicker`
  // toggles the QuickOpen-style file picker.
  const [contextFiles, setContextFiles] = useState<
    { rel: string; path: string; content: string }[]
  >([]);
  const [acPicker, setAcPicker] = useState(false);
  const scope = useFileScope();

  // Resolve the project the edited file belongs to (the longest project directory
  // that is a prefix of `path`), falling back to the active project — so the
  // context-file picker lists the right project even in a detached window.
  const acProjectDir = useMemo(() => {
    const { projects, activeId } = useProjectsStore.getState();
    let best = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > best.length) {
        best = dir;
      }
    }
    if (best) return best;
    const active = projects.find((p) => p.id === activeId);
    return active ? resolveProjectDirectory(active) : "";
  }, [path]);

  const addContextFile = useCallback(
    async (rel: string) => {
      if (!acProjectDir) return;
      const abs = `${acProjectDir}/${rel}`;
      if (contextFiles.some((f) => f.path === abs)) return; // already attached
      try {
        const content = await readFileText(abs, scope);
        setContextFiles((prev) =>
          prev.some((f) => f.path === abs) ? prev : [...prev, { rel, path: abs, content }],
        );
      } catch {
        /* unreadable file: silently skip */
      }
    },
    [acProjectDir, contextFiles, scope],
  );

  const removeContextFile = useCallback((abs: string) => {
    setContextFiles((prev) => prev.filter((f) => f.path !== abs));
  }, []);

  // \ref/\cite key completion (LaTeX viewer): the open dropdown's context, the
  // filtered items, the highlighted index, and the screen anchor. A caret tick
  // re-runs the detector when the caret moves without the text changing (arrow
  // keys / clicks). `complClosedAt` suppresses immediately reopening at the exact
  // caret we dismissed at (e.g. right after accepting a key).
  const [compl, setCompl] = useState<{
    ctx: TexComplContext;
    items: TexComplItem[];
    index: number;
    pos: { left: number; top: number; height: number };
  } | null>(null);
  const [caretTick, setCaretTick] = useState(0);
  const complClosedAt = useRef(-1);
  // Source index of a space auto-inserted after `}` when a completion was
  // accepted (else null). If the very next keystroke is closing punctuation, the
  // space is removed so it reads "\cite{x}." rather than "\cite{x} .".
  const autoSpace = useRef<number | null>(null);
  const bumpCaret = useCallback(() => setCaretTick((t) => t + 1), []);

  // Snap the line-height to whole device pixels so the textarea caret and the
  // highlight <pre> share a vertical grid and don't drift apart over a long file
  // under fractional display scaling (see snapToDevicePx).
  const dpr = useDevicePixelRatio();

  const draftLines = useMemo(
    () => (loaded ? draft.split("\n") : [""]),
    [loaded, draft],
  );
  const lineCount = Math.max(1, draftLines.length);

  // In soft-wrap mode (the LaTeX viewer) a logical line can span several visual
  // rows, so the gutter can't use fixed-height rows. We measure each logical
  // line's wrapped height from a hidden, full-width mirror (`measureRef`) and
  // size the gutter cells to match, keeping the numbers aligned. `lineHeights`
  // stays empty in non-wrap mode (where fixed rows are used) and until the first
  // measure; `measureNonce` re-triggers measurement on editor resize.
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const [measureNonce, bumpMeasure] = useReducer((n: number) => n + 1, 0);

  // Soft-wrap content width (wrap mode only): the textarea's clientWidth, which
  // excludes its vertical scrollbar. The overlay <pre> layers live in a
  // scrollbar-free, overflow:hidden parent, so left at min-width:100% they wrap
  // at the full box width — wider than the textarea once a vertical scrollbar
  // appears — and the caret drifts from the coloured glyphs over wrapped lines.
  // Constraining the overlays to this width makes every layer wrap identically.
  const [wrapWidth, setWrapWidth] = useState<number | null>(null);
  // Last `clientWidth` the textarea was re-broken at. A vertical scrollbar
  // appearing/disappearing as the document grows past the editor height changes
  // clientWidth WITHOUT changing the border box, so the ResizeObserver below
  // never fires and the textarea keeps its stale wrapping (WebKitGTK won't
  // re-break on its own — see the nudge there). The overlay <pre>s, sized to the
  // fresh clientWidth each keystroke, then wrap at a different width, so the
  // coloured glyphs and the last-change tint drift down a row. Tracking the
  // width here lets the wrap layout effect nudge a re-break when it shifts.
  const prevClientWidth = useRef<number | null>(null);

  // Syntax-highlighted HTML rendered in a <pre> layer behind a transparent
  // textarea, so the file colours by type while staying fully editable. `null`
  // (unknown language or a file too large to re-highlight on each keystroke)
  // means we show the plain opaque textarea instead. A trailing newline mirrors
  // the textarea's own final empty line so scrolling stays aligned.
  const lang = useMemo(() => languageForPath(path), [path]);
  const highlighted = useMemo(
    () => (loaded ? highlight(draft, lang) : null),
    [loaded, draft, lang],
  );

  // #49 link-decoration layer (only when a ranges fn is supplied).
  const linkHtml = useMemo(
    () => (loaded && linkRanges ? decorateLinkRanges(draft, linkRanges(draft)) : null),
    [loaded, draft, linkRanges],
  );

  // Keep the gutter and the overlay (highlight/link) layers aligned with the
  // textarea scroll. Reads the live textarea so it can be re-run on events that
  // move the scroll WITHOUT firing a scroll event — notably a resize.
  //
  // We translate the layers with a transform rather than setting their own
  // scrollTop/scrollLeft. A long line gives the textarea (overflow:auto) a
  // horizontal scrollbar, which shrinks its client height and inflates its max
  // scrollTop by the scrollbar thickness; the overlays (overflow:hidden) have no
  // scrollbar and a smaller max scrollTop, so mirroring the value would CLAMP at
  // the bottom and shift the whole overlay ~a line out of register. A transform
  // is not clamped to the content, so it tracks the textarea exactly even past
  // the overlay's own scroll range.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { scrollTop, scrollLeft } = ta;
    if (gutterInnerRef.current) {
      gutterInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    // Blame column + current-line inline hint scroll-lock vertically with the
    // numbers (they never shift horizontally, so translateY only).
    if (blameInnerRef.current) {
      blameInnerRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    if (blameInlineRef.current) {
      blameInlineRef.current.style.transform = `translateY(${-scrollTop}px)`;
    }
    const transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    for (const ref of [
      highlightRef,
      linkLayerRef,
      searchLayerRef,
      changeLayerRef,
      deleteLayerRef,
      grammarLayerRef,
    ]) {
      if (ref.current) ref.current.style.transform = transform;
    }
    // The ghost layer keeps the inset/overflow:hidden model (it masks the layers
    // beneath with an opaque background, so it can't be sized to its own content
    // like the transform-synced layers); scroll it programmatically instead.
    if (ghostRef.current) {
      ghostRef.current.scrollTop = scrollTop;
      ghostRef.current.scrollLeft = scrollLeft;
    }
  }, []);

  // #viewerpos: restore the saved scroll once the file has loaded (and the
  // textarea can actually reach it), then persist subsequent scrolling. The
  // restore is one-shot so it never fights the reader after the first apply.
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current || !loaded) return;
    const ta = textareaRef.current;
    if (!ta) return;
    restoredScroll.current = true;
    if (initialScrollTop && initialScrollTop > 0) {
      ta.scrollTop = initialScrollTop;
      syncScroll();
    }
  }, [loaded, initialScrollTop, syncScroll]);

  // Throttle scroll persistence so a flick of the wheel doesn't churn the store
  // (and its debounced disk save) every frame; the trailing edge captures the
  // final resting position.
  const persistTimer = useRef<number | null>(null);
  const onScroll = () => {
    syncScroll();
    reportScrollSync();
    if (!onScrollPersist || !restoredScroll.current) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => onScrollPersist(top), 200);
  };
  useEffect(
    () => () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  // #67 in-editor search (Ctrl/Cmd+F) and find-and-replace (Ctrl/Cmd+R). A
  // floating bar over the editor with next/previous navigation, a live match
  // count, and a case toggle; matches are painted by a transparent overlay layer
  // (`decorateSearchRanges`) aligned to the textarea exactly like the highlight/
  // link layers. Ctrl/Cmd+R opens the same bar with the replace row revealed.
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => (loaded && findOpen && query ? findMatches(draft, query, caseSensitive) : []),
    [loaded, findOpen, draft, query, caseSensitive],
  );
  const searchHtml = useMemo(
    () => (matches.length > 0 ? decorateSearchRanges(draft, matches, current) : null),
    [draft, matches, current],
  );

  // 1-based line numbers that hold a match (and the current match's line), so the
  // gutter can mark where the hits are (#67). A line number is 1 + the count of
  // newlines before the match's start offset.
  const matchLineSet = useMemo(() => {
    const set = new Set<number>();
    for (const m of matches) set.add(offsetToLineCol(draft, m.start).line);
    return set;
  }, [matches, draft]);
  const currentMatchLine = useMemo(() => {
    const m = matches[current];
    return m ? offsetToLineCol(draft, m.start).line : 0;
  }, [matches, current, draft]);

  // ── Git blame overlay (#blame) ─────────────────────────────────────────────
  // When `showBlame` is set, the gutter grows a per-line blame column (its own
  // inner, scroll-synced with the numbers), the caret's line gets a faint inline
  // attribution, and hovering a blame cell shows a hovercard. All read-only —
  // nothing here touches the editable textarea/highlight/save path.
  const [caretLine, setCaretLine] = useState(1);
  const [blameTip, setBlameTip] = useState<{ left: number; top: number; line: number } | null>(null);
  const effectiveLineHeight = lineHeight ?? Math.round((fontSize ?? 12) * 1.5);

  // Top offset (px, before scroll) of a 1-based line's first row. Mirrors the
  // gutter/editor 10px top padding and the wrap-mode measured `lineHeights`.
  const lineTop = useCallback(
    (line: number) => {
      let top = 10; // `.file-viewer-highlight/-editor` padding-top
      const idx = Math.max(0, line - 1);
      if (wrap && lineHeights.length) {
        for (let i = 0; i < idx && i < lineHeights.length; i++) top += lineHeights[i];
      } else {
        top += idx * effectiveLineHeight;
      }
      return top;
    },
    [wrap, lineHeights, effectiveLineHeight],
  );

  const caretBlame = showBlame ? blame?.get(caretLine) : undefined;

  // Age-tint a blame cell: newer commits are more saturated, decaying with age
  // so the column reads as a heat-map of recent activity. No tint for
  // uncommitted/unknown lines.
  const blameTint = useCallback((b: BlameLine | undefined): string | undefined => {
    if (!b || isUncommitted(b) || !b.author_time) return undefined;
    const ageDays = Math.max(0, (Date.now() / 1000 - b.author_time) / 86400);
    const a = 0.16 * Math.exp(-ageDays / 180);
    if (a < 0.01) return undefined;
    return `rgba(120, 150, 220, ${a.toFixed(3)})`;
  }, []);

  const onBlameMove = useCallback(
    (e: React.MouseEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>(".file-viewer-blame-line");
      const line = cell ? Number(cell.dataset.line) : 0;
      const b = line ? blame?.get(line) : undefined;
      if (!cell || !b || isUncommitted(b)) {
        setBlameTip(null);
        return;
      }
      setBlameTip({ left: e.clientX, top: e.clientY, line });
    },
    [blame],
  );

  // Keep the current index in range as the draft (and so the match set) changes.
  useEffect(() => {
    if (current > 0 && current >= matches.length) {
      setCurrent(matches.length > 0 ? matches.length - 1 : 0);
    }
  }, [matches.length, current]);

  // Place the textarea selection on match `index` and scroll its line to roughly
  // the middle of the view. Focus stays in the find input so Enter keeps cycling;
  // the overlay's `current` highlight shows where we are. The line-based scroll
  // mirrors the SyncTeX `gotoLine` math (approximate under soft-wrap, exact else).
  const revealMatch = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      const m = matches[index];
      if (!el || !m) return;
      el.selectionStart = m.start;
      el.selectionEnd = m.end;
      const line = draft.slice(0, m.start).split("\n").length; // 1-based
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
      el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 2 + lh);
      syncScroll();
    },
    [matches, draft, syncScroll],
  );

  const goToMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (current + dir + matches.length) % matches.length;
      setCurrent(next);
      revealMatch(next);
    },
    [matches.length, current, revealMatch],
  );

  const openFind = useCallback((replace = false) => {
    const el = textareaRef.current;
    const sel =
      el && el.selectionStart !== el.selectionEnd
        ? el.value.slice(el.selectionStart, el.selectionEnd)
        : "";
    if (sel && !sel.includes("\n")) setQuery(sel);
    setFindOpen(true);
    if (replace) setReplaceOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setReplaceOpen(false);
    textareaRef.current?.focus();
  }, []);

  // Latest draft, read by closures (compile/forward-search/diff) that must see the
  // current text without re-subscribing.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Change-tint trail: tint recently typed runs with a sequential new→old colour
  // gradient that fades as typing continues. Every edit flows through `edit`,
  // which diffs old→new: the new run becomes tier 0 (newest), existing runs are
  // re-mapped through the edit so they keep tracking their characters and are
  // pushed one tier older; anything past CHANGE_TIERS or overwritten by the edit
  // drops off. `lastEditRef` lets the effect tell our own edits from a draft
  // change by another path (disk reload, undo/redo) and clear a now-stale trail.
  // Reloads go through the parent's `reset`, never `edit`, so they never light the
  // trail. A short idle decay retires the oldest run on a timer so the trail
  // fades away after typing stops. The whole feature is gated on the (default-ON)
  // `change_tint` setting.
  const changeTint = useSettingsStore((s) => s.settings?.change_tint !== false);
  const changeTintRef = useRef(changeTint);
  changeTintRef.current = changeTint;
  const [changes, setChanges] = useState<ChangeRange[]>([]);
  // Red strike-through ghosts of just-deleted text (mirrors the green change
  // trail on the removal side). Each is retired on its own timer after
  // DELETE_GHOST_MS; `deleteIdRef` mints ids and `deleteTimersRef` tracks the
  // pending timeouts so they can be cleared on unmount / trail reset.
  const [deletes, setDeletes] = useState<DeleteGhost[]>([]);
  const deleteIdRef = useRef(0);
  const deleteTimersRef = useRef<number[]>([]);
  const clearDeleteTimers = useCallback(() => {
    deleteTimersRef.current.forEach((t) => window.clearTimeout(t));
    deleteTimersRef.current = [];
  }, []);
  const scheduleDeleteRemoval = useCallback((id: number) => {
    const t = window.setTimeout(() => {
      setDeletes((prev) => prev.filter((g) => g.id !== id));
    }, DELETE_GHOST_MS);
    deleteTimersRef.current.push(t);
  }, []);
  useEffect(() => () => clearDeleteTimers(), [clearDeleteTimers]);
  const lastEditRef = useRef<string | null>(null);
  const edit = useCallback(
    (next: string) => {
      if (next !== draftRef.current) {
        if (changeTintRef.current) {
          const span = editSpan(draftRef.current, next);
          if (span) {
            setChanges((prev) => {
              const remapped = prev
                .map((r) => remapChangeRange(r, span))
                .filter((r): r is { start: number; end: number } => r != null);
              const merged =
                span.endNext > span.start
                  ? [{ start: span.start, end: span.endNext }, ...remapped]
                  : remapped;
              // newest-first → re-index so tier === age (0 = newest).
              return merged.slice(0, CHANGE_TIERS).map((r, i) => ({ ...r, tier: i }));
            });
            // Removed text (if any) becomes a red strike-through ghost anchored
            // where it vanished; existing ghosts are re-mapped through this edit
            // (dropped if their anchor sat inside the edited run) so they keep
            // pointing at the right spot.
            const removed = deletionGhostText(draftRef.current.slice(span.start, span.endPrev));
            const ghost: DeleteGhost | null =
              removed !== null
                ? { id: deleteIdRef.current++, pos: span.endNext, text: removed, born: Date.now() }
                : null;
            if (ghost) scheduleDeleteRemoval(ghost.id);
            setDeletes((prev) => {
              const remapped = prev
                .map((g) => {
                  const r = remapChangeRange({ start: g.pos, end: g.pos }, span);
                  return r ? { ...g, pos: r.start } : null;
                })
                .filter((g): g is DeleteGhost => g != null);
              return ghost ? [...remapped, ghost] : remapped;
            });
          }
        }
        lastEditRef.current = next;
      }
      setDraft(next);
    },
    [setDraft, scheduleDeleteRemoval],
  );
  // Drop a stale trail when the draft changes by some path other than our own
  // `edit` (disk reload, undo/redo), and clear it when the feature is turned off.
  useEffect(() => {
    if (lastEditRef.current !== null && draft !== lastEditRef.current) {
      setChanges([]);
      setDeletes([]);
      clearDeleteTimers();
      lastEditRef.current = null;
    }
  }, [draft, clearDeleteTimers]);
  useEffect(() => {
    if (!changeTint) {
      setChanges([]);
      setDeletes([]);
      clearDeleteTimers();
    }
  }, [changeTint, clearDeleteTimers]);
  // Idle decay: each keystroke resets this timer (re-runs on every `changes`
  // update), so while typing the trail stays; once typing stops it retires the
  // oldest run every CHANGE_DECAY_MS until the trail is gone.
  useEffect(() => {
    if (changes.length === 0) return;
    const id = window.setTimeout(() => {
      setChanges((prev) => prev.slice(0, -1).map((r, i) => ({ ...r, tier: i })));
    }, CHANGE_DECAY_MS);
    return () => window.clearTimeout(id);
  }, [changes]);
  const changeHtml = useMemo(
    () => (loaded && changeTint && changes.length ? decorateChangeRanges(draft, changes) : null),
    [loaded, draft, changes, changeTint],
  );
  // Companion overlay for the red deletion ghosts. `Date.now()` here stamps each
  // mark's fade offset; it re-evaluates on every draft/deletes change (i.e. every
  // keystroke), which is exactly when the layer is rebuilt.
  const deleteHtml = useMemo(
    () => (loaded && changeTint && deletes.length ? decorateDeleteRanges(draft, deletes, Date.now()) : null),
    [loaded, draft, deletes, changeTint],
  );

  // ── #45 follow-up: local-model grammar/spelling check ──────────────────────
  // The whole draft is checked against the currently-loaded local model after an
  // idle pause; the returned issues are resolved to ranges against the live draft
  // (so they self-heal across small edits) and underlined, colour by category. A
  // short status mirrors the autocomplete one. Disabled unless `grammarCheck`.
  const [grammarIssues, setGrammarIssues] = useState<GrammarIssue[]>([]);
  const [grammarStatus, setGrammarStatus] = useState<string | null>(null);
  const [grammarTip, setGrammarTip] = useState<
    { left: number; top: number; range: GrammarRange } | null
  >(null);
  const grammarAbort = useRef<AbortController | null>(null);
  // The exact draft text last submitted, so an idle re-check is skipped when the
  // document hasn't changed since the previous check.
  const lastCheckedText = useRef<string | null>(null);
  // Close the hover tooltip on a short delay, so the pointer can travel from the
  // underlined mark up into the tooltip (to click Apply) without it vanishing.
  const grammarTipTimer = useRef<number | null>(null);
  const cancelGrammarTipClose = useCallback(() => {
    if (grammarTipTimer.current != null) {
      window.clearTimeout(grammarTipTimer.current);
      grammarTipTimer.current = null;
    }
  }, []);
  const scheduleGrammarTipClose = useCallback(() => {
    cancelGrammarTipClose();
    grammarTipTimer.current = window.setTimeout(() => setGrammarTip(null), 250);
  }, [cancelGrammarTipClose]);
  useEffect(() => () => cancelGrammarTipClose(), [cancelGrammarTipClose]);

  const grammarRanges = useMemo(
    () => (loaded && grammarIssues.length ? resolveGrammarRanges(draft, grammarIssues) : []),
    [loaded, draft, grammarIssues],
  );
  const grammarHtml = useMemo(
    () => (grammarRanges.length ? decorateGrammarRanges(draft, grammarRanges) : null),
    [draft, grammarRanges],
  );

  // Re-apply the scroll transform whenever an overlay layer's presence changes.
  // syncScroll only runs on scroll events and the one-shot restore, but the
  // change/delete trails (and the search layer) mount lazily — only once there's
  // an edit or an active find. A layer that first mounts while the textarea is
  // already scrolled starts at translate(0,0), i.e. `scrollTop` px too low, and
  // stays out of register until the next scroll. Syncing on mount pins it to the
  // current offset immediately. useLayoutEffect so it lands before paint.
  useLayoutEffect(() => {
    syncScroll();
  }, [
    loaded,
    highlighted,
    linkHtml,
    searchHtml,
    changeHtml,
    deleteHtml,
    grammarHtml,
    syncScroll,
  ]);

  // Auto-dismiss a finished grammar status; keep an in-flight "…" message.
  useEffect(() => {
    if (!grammarStatus || grammarStatus.endsWith("…")) return;
    const id = window.setTimeout(() => setGrammarStatus(null), 4000);
    return () => window.clearTimeout(id);
  }, [grammarStatus]);

  const runGrammarCheck = useCallback(async () => {
    if (!grammarCheck?.enabled) return;
    const text = draftRef.current;
    if (!text.trim()) {
      setGrammarIssues([]);
      return;
    }
    lastCheckedText.current = text;
    grammarAbort.current?.abort();
    const ctl = new AbortController();
    grammarAbort.current = ctl;
    setGrammarStatus("Checking grammar…");
    try {
      // Resolve the currently-loaded model the same way autocomplete does, so the
      // check runs against whatever is resident in Ollama at trigger time.
      const detailed = await invoke<{ name: string; running: boolean }[]>(
        "list_ollama_models_detailed",
      );
      if (ctl.signal.aborted) return;
      const running = detailed.filter((m) => m.running).map((m) => m.name);
      const model =
        grammarCheck.preferred && running.includes(grammarCheck.preferred)
          ? grammarCheck.preferred
          : running[0] ?? "";
      if (!model) {
        setGrammarStatus("Grammar check unavailable — load a local model (🧠 menu) to enable it.");
        return;
      }
      const issues = await invoke<GrammarIssue[]>("check_grammar", {
        text,
        model,
        language: lang === "plain" ? "" : lang,
      });
      if (ctl.signal.aborted) return;
      setGrammarIssues(issues);
      setGrammarStatus(issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "No issues");
    } catch (e) {
      if (ctl.signal.aborted) return;
      setGrammarStatus(
        String(e).includes("not_running")
          ? "Grammar check unavailable — load a local model (🧠 menu) to enable it."
          : "Grammar check failed — see the local model.",
      );
    }
    // Primitive deps (the config object's identity changes every render) so the
    // idle-check timer isn't reset by unrelated re-renders.
  }, [grammarCheck?.enabled, grammarCheck?.preferred, lang]);

  // Idle re-check: when enabled, run a short while after the user stops typing,
  // skipping when the draft is unchanged from the last check. Clears stale marks
  // immediately when the feature is turned off.
  useEffect(() => {
    if (!grammarCheck?.enabled || !loaded) {
      setGrammarIssues([]);
      setGrammarTip(null);
      lastCheckedText.current = null;
      return;
    }
    if (draft === lastCheckedText.current) return;
    const id = window.setTimeout(() => void runGrammarCheck(), GRAMMAR_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [grammarCheck?.enabled, loaded, draft, runGrammarCheck]);

  // Keep the grammar overlay aligned after it mounts/changes.
  useEffect(() => {
    if (grammarHtml) syncScroll();
  }, [grammarHtml, syncScroll]);

  // Apply a single issue's suggested fix: replace its resolved range with the
  // suggestion and drop the issue so its mark clears (the rest re-resolve against
  // the new draft). Leaves the caret after the inserted text.
  const applyGrammarFix = useCallback(
    (range: GrammarRange) => {
      const repl = range.issue.suggestion;
      edit(applyReplacements(draftRef.current, [{ start: range.start, end: range.end }], repl));
      setGrammarIssues((prev) => prev.filter((i) => i !== range.issue));
      setGrammarTip(null);
      const caret = range.start + repl.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) el.selectionStart = el.selectionEnd = caret;
      });
    },
    [edit],
  );

  // Hit-test the grammar overlay at a screen point, returning the range under the
  // cursor (its span carries `data-gi`, an index into `grammarRanges`). Mirrors
  // the link-layer hit-test: the layer is scroll-synced over the textarea text, so
  // its span rects are the on-screen marks.
  const grammarHitAt = useCallback(
    (x: number, y: number): GrammarRange | null => {
      const layer = grammarLayerRef.current;
      if (!layer) return null;
      for (const span of layer.querySelectorAll<HTMLElement>(".file-viewer-grammar-mark")) {
        const r = span.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const gi = Number(span.dataset.gi);
          return grammarRanges[gi] ?? null;
        }
      }
      return null;
    },
    [grammarRanges],
  );

  // Replace the current match (#67). We re-place the textarea selection on the
  // match first so the change history records a single, intelligible edit, then
  // splice `replaceWith` in via setDraft. The match set recomputes on the new
  // draft; the live `current` clamp keeps the index in range, leaving the next
  // occurrence selected so repeated Replace walks through them.
  const replaceCurrent = useCallback(() => {
    const m = matches[current];
    if (!m) return;
    edit(applyReplacements(draft, [m], replaceWith));
    // Put the caret just after the inserted text so a follow-up reveal lands here.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = m.start + replaceWith.length;
    });
  }, [matches, current, draft, replaceWith, edit]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    edit(applyReplacements(draft, matches, replaceWith));
  }, [matches, draft, replaceWith, edit]);

  // Reset to the first match whenever the query/case changes or the bar opens, so
  // typing jumps to the first hit. Reveal is deferred a frame so the recomputed
  // `matches` and the just-mounted overlay are in place.
  useEffect(() => {
    if (!findOpen) return;
    setCurrent(0);
    const id = requestAnimationFrame(() => revealMatch(0));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, findOpen]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // In the replace field, Enter replaces the current match (Ctrl/Cmd+Enter does
  // Replace All), and Escape closes the bar.
  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) replaceAll();
      else replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  };

  // Ctrl/Cmd+F opens the find bar; Ctrl/Cmd+R opens it with the replace row. Bound
  // on the container so it fires whenever focus is anywhere in the editor pane
  // (the cursor is in the tab), not only when the textarea holds focus — it
  // catches the key as it bubbles up. Ctrl/Cmd+R is also always intercepted so it
  // never falls through to the webview's page reload, which would tear down the app.
  const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      if (replaceOpen) replaceInputRef.current?.focus();
      else openFind(true);
    }
  };

  // Re-sync the overlay layers whenever the editor is resized (window resize,
  // pane/divider drag, panel toggle). A resize can clamp the textarea's
  // scrollLeft/scrollTop without emitting a scroll event, which otherwise leaves
  // the coloured glyphs — and so the visible caret — shifted from the text. A
  // ResizeObserver on the textarea catches every cause (it is full-width, so a
  // window resize changes its box too). Guarded for jsdom, where it's absent.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // WebKitGTK quirk: a soft-wrap textarea re-breaks its lines when its box
      // shrinks but NOT when it grows, so after the editor widens the text stays
      // wrapped at the old, narrower width and leaves blank space on the right.
      // Nudge it to re-lay-out at the new width by toggling its wrap off→on within
      // a single synchronous reflow (no paint between, so no flicker; the value —
      // and thus caret/selection — is untouched).
      if (wrap) {
        ta.style.whiteSpace = "pre";
        void ta.offsetWidth;
        ta.style.whiteSpace = "";
      }
      syncScroll();
      bumpMeasure();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll, loaded, wrap]);

  // Measure each logical line's wrapped height (wrap mode only) so the gutter
  // cells line up with the editor. Runs before paint to avoid a flash of
  // misaligned numbers. The mirror is sized to the textarea's content width
  // (clientWidth excludes the vertical scrollbar) so it wraps line-for-line.
  useLayoutEffect(() => {
    if (!wrap || !loaded) {
      setWrapWidth(null);
      prevClientWidth.current = null;
      return;
    }
    const measure = measureRef.current;
    const ta = textareaRef.current;
    if (!measure || !ta) return;
    const cw = ta.clientWidth;
    // If the content width changed since the last measure — most often a vertical
    // scrollbar toggling as the doc crosses the editor height, which the
    // ResizeObserver can't see — force the textarea to re-break to the new width
    // with the same whiteSpace nudge used on resize (synchronous, pre-paint, so
    // no flicker and the value/caret are untouched). Keeps its wrapping in lockstep
    // with the overlay layers pinned to `cw`, so the last-change tint stays put.
    if (prevClientWidth.current !== cw) {
      prevClientWidth.current = cw;
      ta.style.whiteSpace = "pre";
      void ta.offsetWidth;
      ta.style.whiteSpace = "";
    }
    setWrapWidth(cw);
    measure.style.width = `${cw}px`;
    const next = Array.from(
      measure.children,
      (c) => (c as HTMLElement).offsetHeight,
    );
    setLineHeights((prev) =>
      prev.length === next.length && prev.every((h, i) => h === next[i])
        ? prev
        : next,
    );
  }, [wrap, loaded, draftLines, fontSize, lineHeight, measureNonce]);

  // Report the caret position so the LaTeX viewer can run SyncTeX forward search
  // from it. Cheap; only wired when `onCaretChange` is supplied.
  //
  // Guard on focus: WebKitGTK collapses a textarea's selection to offset 0 as it
  // loses focus and fires a spurious `select` event for that reset. Clicking the
  // Compile button blurs the editor, so without this guard that 0 would clobber
  // the caret the viewer uses for forward search — the cursor would appear to
  // jump to the top of the file and SyncTeX would look up line 1 (the preamble,
  // which has no output mapping) instead of the real caret. Only report while
  // the textarea is actually focused so a blur-time reset is ignored.
  const emitCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      if (document.activeElement === el && onCaretChange) onCaretChange(el.selectionStart);
      // Track the caret's line for the blame inline hint (cheap; only read).
      setCaretLine(offsetToLineCol(el.value, el.selectionStart).line);
    }
    bumpCaret();
  }, [onCaretChange, bumpCaret]);

  // Re-apply the scroll transform to the blame layers whenever they (re)mount or
  // the caret line changes: a freshly-mounted node starts at translateY(0), so
  // without this the column/inline hint would sit un-scrolled until the next
  // scroll event. syncScroll reads the live textarea scrollTop.
  useEffect(() => {
    if (showBlame) syncScroll();
  }, [showBlame, caretLine, blame, syncScroll]);

  // Publish a live caret getter so the viewer can read the *current* cursor at
  // compile time rather than relying on the last-reported snapshot. The Compile
  // button keeps focus (its onMouseDown preventDefault), so at the moment compile
  // runs `selectionStart` is the real cursor — robust even when no caret event
  // ever fired (the snapshot would still be its initial 0). Cleared on unmount so
  // a stale closure can't outlive the editor.
  useEffect(() => {
    if (!caretApiRef) return;
    caretApiRef.current = () => textareaRef.current?.selectionStart ?? null;
    return () => {
      caretApiRef.current = null;
    };
  }, [caretApiRef]);

  // Imperative editing API for a toolbar (the Markdown viewer). `applyEdit` runs
  // a pure transform on the current value+selection and commits it through
  // `edit`; the requested selection is stashed and restored by the layout effect
  // below once React has re-rendered the textarea with the new value.
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (!editorApiRef) return;
    editorApiRef.current = {
      applyEdit: (fn) => {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? draftRef.current.length;
        const end = el?.selectionEnd ?? start;
        const res = fn(draftRef.current, start, end);
        pendingSelRef.current = { start: res.selStart, end: res.selEnd };
        el?.focus();
        edit(res.value);
      },
    };
    return () => {
      editorApiRef.current = null;
    };
  }, [editorApiRef, edit]);
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    if (!sel) return;
    pendingSelRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.selectionStart = sel.start;
    el.selectionEnd = sel.end;
  }, [draft]);

  // SyncTeX reverse search: on a new `gotoLine` nonce, place the caret at the
  // target line/column and scroll it to roughly the middle of the view. SyncTeX
  // reports a column (0 when it has none); we offset into the line by it, clamped
  // to the line's end so a stale column can't spill onto the next line.
  useEffect(() => {
    if (!gotoLine || !loaded) return;
    const el = textareaRef.current;
    if (!el) return;
    const text = draftRef.current;
    const lineStart = lineStartOffset(text, gotoLine.line);
    let offset = lineStart;
    if (gotoLine.column && gotoLine.column > 1) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? text.length : nl;
      offset = Math.min(lineStart + (gotoLine.column - 1), lineEnd);
    }
    el.focus();
    el.selectionStart = el.selectionEnd = offset;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const target = (gotoLine.line - 1) * lh - el.clientHeight / 2 + lh;
    el.scrollTop = Math.max(0, target);
    syncScroll();
    onGotoApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoLine?.nonce, loaded]);

  const dismissSuggestion = useCallback(() => {
    acAbort.current?.abort();
    acAbort.current = null;
    setSuggestion(null);
    setAcStatus(null);
  }, []);

  // #45: request a completion at the caret. Privacy-gated by the caller (only
  // wired when the per-type setting is on). Completion runs against whichever
  // local model is CURRENTLY LOADED in Ollama memory (the running set from
  // /api/ps), preferring the user's active model when it is loaded.
  //
  // Two modes:
  //  - manual (Ctrl+Space): surfaces a message when nothing is loaded / it fails,
  //    so the user gets feedback rather than silence.
  //  - auto (debounced as you type): only runs for the focused editor with a
  //    collapsed caret and enough context, and stays SILENT on the unavailable/
  //    error paths so typing isn't spammed with toasts. There is no remote
  //    fallback either way (local-only by design, DECISION A).
  const requestCompletion = useCallback(async (opts?: { auto?: boolean; mode?: AutocompleteMode }) => {
    const auto = opts?.auto === true;
    // Explicit override (from the live cycle key) wins over the current mode,
    // since setState hasn't flushed yet when the key handler calls through.
    const mode = opts?.mode ?? acMode;
    const el = textareaRef.current;
    if (!el || !autocomplete?.enabled) return;
    // Auto mode: only the focused editor, only at a collapsed caret, and only
    // with a little context to complete from — otherwise skip the round trip.
    if (auto) {
      if (document.activeElement !== el) return;
      if (el.selectionStart !== el.selectionEnd) return;
    }
    const caret = el.selectionStart;
    const prefix = draft.slice(0, caret);
    const suffix = draft.slice(caret);
    if (auto && prefix.replace(/\s+/g, "").length < 3) return;
    acAbort.current?.abort();
    const ctl = new AbortController();
    acAbort.current = ctl;
    setSuggestion(null);
    setAcStatus(`Autocomplete · ${AC_MODE_LABELS[mode]}…`);
    try {
      // Resolve the currently-loaded model at trigger time (it may have been
      // unloaded since the editor mounted). `list_ollama_models_detailed`
      // doubles as the running-check; "not_running" means Ollama is down.
      const detailed = await invoke<{ name: string; running: boolean }[]>(
        "list_ollama_models_detailed",
      );
      if (ctl.signal.aborted) return;
      const loaded = detailed.filter((m) => m.running).map((m) => m.name);
      const model =
        autocomplete.preferred && loaded.includes(autocomplete.preferred)
          ? autocomplete.preferred
          : loaded[0] ?? "";
      if (!model) {
        setAcStatus(
          auto ? null : "Autocomplete unavailable — load a local model (🧠 menu) to enable it.",
        );
        return;
      }
      const text = await invoke<string>("complete_text", {
        prefix,
        suffix,
        model,
        language: lang === "plain" ? "" : lang,
        mode,
        context: contextFiles.length
          ? contextFiles.map((f) => ({ name: f.rel, content: f.content }))
          : undefined,
      });
      if (ctl.signal.aborted) return;
      if (text) {
        setSuggestion({ text, at: caret });
        setAcStatus(null);
      } else {
        setAcStatus(auto ? null : "No suggestion");
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      if (auto) {
        setAcStatus(null);
        return;
      }
      setAcStatus(
        String(e).includes("not_running")
          ? "Autocomplete unavailable — load a local model (🧠 menu) to enable it."
          : "Autocomplete failed — see the local model.",
      );
    }
  }, [autocomplete, draft, lang, acMode, contextFiles]);

  // #45 automatic suggestions: when the per-type toggle is on, request a
  // completion a short while after the user stops typing. Re-runs on each draft
  // change; the cleanup clears the prior timer, so only an idle pause fires it.
  // Skipped while a suggestion is already showing or the \ref/\cite dropdown is
  // open. The focus/caret/context guards live in `requestCompletion`.
  useEffect(() => {
    if (!autocomplete?.enabled || !loaded) return;
    if (suggestion || compl) return;
    const id = window.setTimeout(() => void requestCompletion({ auto: true }), AUTO_AC_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [autocomplete?.enabled, loaded, draft, suggestion, compl, requestCompletion]);

  // The ghost mounts fresh (scrollTop 0) each time a suggestion appears; align it
  // to the editor's current scroll so the inserted preview lands at the caret.
  useEffect(() => {
    if (suggestion) syncScroll();
  }, [suggestion, syncScroll]);

  const acceptSuggestion = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const at = suggestion.at;
    const next = draft.slice(0, at) + suggestion.text + draft.slice(at);
    edit(next);
    const caret = at + suggestion.text.length;
    setSuggestion(null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // #45 partial accept (→ Right arrow): insert only the next "word" of the pending
  // suggestion and keep the remainder ghosted, so the user can walk a long
  // suggestion in word-sized steps. A word = any leading whitespace (including a
  // newline + indentation) plus the following run of non-space characters.
  const acceptWord = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const { text, at } = suggestion;
    const m = text.match(/^\s*\S+/);
    const take = m ? m[0].length : text.length;
    const chunk = text.slice(0, take);
    const rest = text.slice(take);
    const next = draft.slice(0, at) + chunk + draft.slice(at);
    edit(next);
    const caret = at + chunk.length;
    // Keep the rest ghosted at the new caret; clear once it's fully consumed.
    setSuggestion(rest ? { text: rest, at: caret } : null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, edit]);

  // \ref/\cite completion: cap the dropdown so a huge .bib can't render
  // thousands of rows; the prefix filter usually narrows it well below this.
  const COMPL_LIMIT = 80;

  // Recompute the completion dropdown for the current caret. No-ops (closes the
  // dropdown) unless `texCompletions` is wired and the collapsed caret sits in a
  // recognised \ref/\cite argument. Items are prefix-then-substring ranked; the
  // highlighted index is preserved while the same token is being extended.
  const refreshCompl = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !texCompletions) { setCompl(null); return; }
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) { setCompl(null); return; }
    if (caret === complClosedAt.current) return; // suppressed at this exact caret
    complClosedAt.current = -1;
    const ctx = findTexComplAt(draft, caret);
    if (!ctx) { setCompl(null); return; }
    const q = ctx.query.toLowerCase();
    let items: TexComplItem[];
    if (ctx.kind === "cite") {
      items = texCompletions.cites
        .filter(
          (e) =>
            !q ||
            e.key.toLowerCase().includes(q) ||
            e.title?.toLowerCase().includes(q) ||
            e.author?.toLowerCase().includes(q),
        )
        .map((e) => ({ value: e.key, detail: citeDetail(e) }));
    } else {
      items = texCompletions.labels
        .filter((l) => !q || l.toLowerCase().includes(q))
        .map((l) => ({ value: l }));
    }
    if (q) {
      items.sort(
        (a, b) =>
          (a.value.toLowerCase().startsWith(q) ? 0 : 1) -
          (b.value.toLowerCase().startsWith(q) ? 0 : 1),
      );
    }
    items = items.slice(0, COMPL_LIMIT);
    if (items.length === 0) { setCompl(null); return; }
    const pos = textareaCaretViewportRect(el, ctx.start);
    setCompl((prev) => {
      const same =
        prev != null &&
        prev.ctx.kind === ctx.kind &&
        prev.ctx.start === ctx.start &&
        prev.ctx.query === ctx.query;
      return { ctx, items, index: same ? Math.min(prev!.index, items.length - 1) : 0, pos };
    });
  }, [draft, texCompletions]);

  // Accept a completion (Tab): replace the token with the key. When it's the
  // last/only key in the braces, close them if needed, jump the caret OUT past
  // `}`, and add a trailing space (tracked in `autoSpace` for smart removal). For
  // a multi-key list (\cite{a,b}) it stays just after the inserted key instead.
  // `complClosedAt` keeps the dropdown from instantly reopening on that caret.
  const acceptCompl = useCallback(
    (value: string) => {
      const el = textareaRef.current;
      if (!el || !compl) return;
      const { start, end } = compl.ctx;
      const head = draft.slice(0, start) + value;
      const rest = draft.slice(end);
      const closeRel = rest.indexOf("}");
      const beforeClose = closeRel >= 0 ? rest.slice(0, closeRel) : rest;
      let next: string;
      let caret: number;
      if (/\S/.test(beforeClose)) {
        // More keys remain inside the braces → keep the caret after this key.
        next = head + rest;
        caret = head.length;
        autoSpace.current = null;
      } else {
        // Last/only key: drop any spaces up to the brace, ensure a closing `}`,
        // then a single space, reusing one already after `}` if present.
        const afterBrace = closeRel >= 0 ? rest.slice(closeRel + 1) : rest;
        const sep = /^\s/.test(afterBrace) ? "}" : "} ";
        next = head + sep + afterBrace;
        autoSpace.current = head.length + 1; // index of the space right after `}`
        caret = head.length + 2; // past `}` and the space
      }
      complClosedAt.current = caret;
      setCompl(null);
      edit(next);
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = el.selectionEnd = caret;
      });
    },
    [compl, draft, edit],
  );

  const closeCompl = useCallback(() => {
    const el = textareaRef.current;
    complClosedAt.current = el ? el.selectionStart : -1;
    setCompl(null);
  }, []);

  // Re-detect the completion context on every text change and caret move.
  useEffect(() => {
    refreshCompl();
  }, [draft, caretTick, refreshCompl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onFollowLink && (e.ctrlKey || e.metaKey) && lastMouse.current) {
      updateLinkHover(lastMouse.current.x, lastMouse.current.y, true);
    }

    // Smart space after accepting a \ref/\cite: the first real keystroke decides
    // the auto space's fate. Closing punctuation right after it replaces it
    // (\cite{x}. not \cite{x} .); any other character commits it. Bare modifier
    // presses (e.g. Shift for `?`) are ignored so they don't drop the space.
    if (autoSpace.current != null && !MODIFIER_KEYS.has(e.key)) {
      const el = textareaRef.current;
      const at = autoSpace.current;
      if (
        e.key.length === 1 &&
        NO_SPACE_BEFORE.has(e.key) &&
        el &&
        el.selectionStart === el.selectionEnd &&
        el.selectionStart === at + 1
      ) {
        e.preventDefault();
        autoSpace.current = null;
        const next = draft.slice(0, at) + e.key + draft.slice(at + 1);
        edit(next);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = at + 1;
        });
        return;
      }
      autoSpace.current = null; // any other real key commits the space
    }

    // \ref/\cite dropdown: arrows move the highlight, Tab accepts (Enter is left
    // to insert a newline), Esc closes. Handled first so it captures Tab.
    if (compl && compl.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCompl((c) => (c ? { ...c, index: (c.index + 1) % c.items.length } : c));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCompl((c) =>
          c ? { ...c, index: (c.index - 1 + c.items.length) % c.items.length } : c,
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        acceptCompl(compl.items[compl.index].value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeCompl();
        return;
      }
    }

    // #45: Ctrl+Space requests a suggestion. While a ghost suggestion is showing:
    //  - Tab accepts the whole suggestion,
    //  - Shift+Tab toggles the completion-length mode (Sentence → Block → Scope)
    //    and re-requests in it,
    //  - → (Right) accepts only the next word (repeat to walk word-by-word),
    //  - Esc dismisses.
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      void requestCompletion();
      return;
    }
    if (suggestion) {
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          // Toggle to the next mode and re-request, so the ghost switches to that
          // mode's completion in place.
          const m = nextAcMode(acMode);
          setAcMode(m);
          void requestCompletion({ mode: m });
        } else {
          acceptSuggestion();
        }
        return;
      }
      // Plain Right arrow accepts the next word; modified Right (select/word-move)
      // falls through and dismisses so native navigation still works.
      if (e.key === "ArrowRight" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        acceptWord();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissSuggestion();
        return;
      }
      // Any other key invalidates the pending suggestion.
      dismissSuggestion();
    }

    // #46 undo/redo.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo?.();
      else undo?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo?.();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      return;
    }
    // Text-size: Ctrl/Cmd with "+"/"=" grows, "-" shrinks, "0" resets.
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        incFont?.();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        decFont?.();
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetFont?.();
        return;
      }
    }
    if (e.key === "Tab") {
      const next = applyIndent(e.currentTarget, e.shiftKey);
      if (!next) return;
      e.preventDefault();
      edit(next.value);
      const el = e.currentTarget;
      requestAnimationFrame(() => {
        el.selectionStart = next.selStart;
        el.selectionEnd = next.selEnd;
      });
    }
  };

  // After a click the textarea's caret (selectionStart) is at the click point,
  // so a Ctrl/Cmd+Click resolves the reference there. The modifier gates it so
  // ordinary clicks keep placing the caret as usual.
  const onClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (suggestion) dismissSuggestion();
    emitCaret();
    if (!onFollowLink || !(e.ctrlKey || e.metaKey)) return;
    onFollowLink(e.currentTarget.selectionStart);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    lastMouse.current = { x: e.clientX, y: e.clientY };
    updateLinkHover(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    // Grammar tooltip: open it over a hovered mark, else schedule a close so the
    // pointer can still reach the open tooltip's Apply button.
    if (grammarRanges.length) {
      const hit = grammarHitAt(e.clientX, e.clientY);
      if (hit) {
        cancelGrammarTipClose();
        setGrammarTip({ left: e.clientX, top: e.clientY, range: hit });
      } else if (grammarTip) {
        scheduleGrammarTipClose();
      }
    }
  };

  if (error != null) return <div className="file-viewer-error">{error}</div>;
  if (!loaded) return <div className="file-viewer-loading">Loading…</div>;

  // Ghost text: while a suggestion is pending, render the WHOLE projected
  // document — prefix + suggestion + the existing suffix shifted past it — over
  // an opaque background that masks the real layers beneath. This pushes the
  // text after the caret aside (horizontally and, for multi-line suggestions,
  // downward) instead of painting the proposal on top of it.
  const hasGhost = suggestion != null;

  // In wrap mode, pin every overlay <pre> to the textarea's content width so
  // they wrap line-for-line with it (see wrapWidth). A no-op otherwise.
  const overlayWidthStyle =
    wrap && wrapWidth != null ? { width: wrapWidth } : undefined;

  return (
    <div
      className="file-viewer-code"
      ref={wheelRef}
      onKeyDown={onContainerKeyDown}
      style={
        fontSize
          ? ({
              "--code-font-size": `${fontSize}px`,
              "--code-line-height": `${snapToDevicePx(
                lineHeight ?? Math.round(fontSize * 1.5),
                dpr,
              )}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {/* Git-blame column (#blame). Sits left of the numbers, shares their cell
          heights (incl. wrap-mode `lineHeights`) and is scroll-locked via its own
          inner transform. Each cell shows the last author + relative date;
          uncommitted/unknown lines get a muted dot. Age-tinted like a heat-map. */}
      {showBlame && (
        <div
          className="file-viewer-blame-gutter"
          aria-hidden="true"
          onMouseMove={onBlameMove}
          onMouseLeave={() => setBlameTip(null)}
        >
          <div className="file-viewer-blame-inner" ref={blameInnerRef}>
            {Array.from({ length: lineCount }, (_, i) => {
              const b = blame?.get(i + 1);
              const h = wrap ? lineHeights[i] : undefined;
              const known = b != null && !isUncommitted(b);
              const style: React.CSSProperties = {};
              if (h != null) style.height = h;
              const tint = blameTint(b);
              if (tint) style.background = tint;
              return (
                <div
                  key={i}
                  className={`file-viewer-blame-line${known ? "" : " uncommitted"}${
                    i + 1 === caretLine ? " current" : ""
                  }`}
                  data-line={i + 1}
                  style={style}
                >
                  {known ? (
                    <>
                      <span className="fv-blame-author">{authorAbbrev(b!.author)}</span>
                      <span className="fv-blame-date">{blameRelDate(b!.author_time)}</span>
                    </>
                  ) : (
                    <span className="fv-blame-none">·</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Line-number gutter. Fixed-height rows normally; in wrap mode (the LaTeX
          viewer) a logical line can span several visual rows, so each cell is
          sized to its measured wrapped height (`lineHeights`). Lines holding a
          search match are marked, the current match brightest (#67).

          When `onToggleBreakpoint` is wired (the Python editor, #py) the cells
          become real buttons that set/clear a debug breakpoint, so the gutter
          stops being decoration and the whole column drops its `aria-hidden` —
          hiding a control from the accessibility tree would make the feature
          unreachable without a mouse. */}
      <div className="file-viewer-gutter" aria-hidden={onToggleBreakpoint ? undefined : "true"}>
        <div className="file-viewer-gutter-inner" ref={gutterInnerRef}>
          {Array.from({ length: lineCount }, (_, i) => {
            const n = i + 1;
            const h = wrap ? lineHeights[i] : undefined;
            const broken = breakpoints?.has(n) ?? false;
            const cls =
              (n === currentMatchLine
                ? "file-viewer-gutter-line current-match"
                : matchLineSet.has(n)
                  ? "file-viewer-gutter-line has-match"
                  : "file-viewer-gutter-line") +
              (onToggleBreakpoint ? " is-breakable" : "") +
              (broken ? " has-breakpoint" : "");
            const style = h != null ? { height: h } : undefined;

            if (!onToggleBreakpoint) {
              return (
                <div key={i} className={cls} style={style}>
                  {n}
                </div>
              );
            }
            return (
              <button
                key={i}
                type="button"
                className={cls}
                style={style}
                // Keep the caret where it is: clicking the gutter sets a
                // breakpoint, it does not move the cursor or steal focus.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onToggleBreakpoint(n)}
                title={broken ? `Remove breakpoint on line ${n}` : `Break on line ${n}`}
                aria-pressed={broken}
                aria-label={broken ? `Remove breakpoint on line ${n}` : `Break on line ${n}`}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className={`file-viewer-code-area${highlighted != null ? " highlighted" : ""}${
          linkHover ? " link-hover" : ""
        }${wrap ? " is-wrapped" : ""}${hasGhost ? " has-suggestion" : ""}`}
      >
        {/* Hidden full-width mirror used only to measure each logical line's
            wrapped height for the gutter (wrap mode). Sized to the textarea's
            content width in the layout effect; never painted. */}
        {wrap && (
          <pre className="file-viewer-gutter-measure" ref={measureRef} aria-hidden="true">
            {draftLines.map((ln, i) => (
              <div key={i} className="fv-measure-line">{ln === "" ? "\u200B" : ln}</div>
            ))}
          </pre>
        )}
        {highlighted != null && (
          <pre
            ref={highlightRef}
            className="file-viewer-highlight"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: highlighted + "\n" }}
          />
        )}
        {changeHtml != null && (
          <pre
            ref={changeLayerRef}
            className="file-viewer-change-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: changeHtml + "\n" }}
          />
        )}
        {searchHtml != null && (
          <pre
            ref={searchLayerRef}
            className="file-viewer-search-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: searchHtml + "\n" }}
          />
        )}
        {grammarHtml != null && (
          <pre
            ref={grammarLayerRef}
            className="file-viewer-grammar-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: grammarHtml + "\n" }}
          />
        )}
        {linkHtml != null && (
          <pre
            ref={linkLayerRef}
            className="file-viewer-link-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: linkHtml + "\n" }}
          />
        )}
        {deleteHtml != null && (
          <pre
            ref={deleteLayerRef}
            className="file-viewer-delete-layer"
            aria-hidden="true"
            style={overlayWidthStyle}
            dangerouslySetInnerHTML={{ __html: deleteHtml + "\n" }}
          />
        )}
        {hasGhost && (
          <pre
            ref={ghostRef}
            className="file-viewer-ghost"
            aria-hidden="true"
            style={overlayWidthStyle}
          >
            {draft.slice(0, suggestion!.at)}
            <span className="file-viewer-ghost-text">{suggestion!.text}</span>
            {draft.slice(suggestion!.at)}
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className="file-viewer-editor file-viewer-code-editor"
          value={draft}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (!(e.ctrlKey || e.metaKey)) setLinkHover(false); emitCaret(); }}
          onBlur={() => { setLinkHover(false); setLinkTip(null); dismissSuggestion(); setCompl(null); }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => { setLinkHover(false); setLinkTip(null); scheduleGrammarTipClose(); }}
          onClick={onClick}
          onSelect={emitCaret}
          onScroll={onScroll}
        />
        {/* Current-line blame hint (#blame): a faint, right-aligned annotation on
            the caret's line. Absolutely positioned at the line's top offset and
            scroll-locked with the blame column. */}
        {showBlame && caretBlame && !isUncommitted(caretBlame) && (
          <div
            ref={blameInlineRef}
            className="file-viewer-blame-inline"
            aria-hidden="true"
            style={{ top: lineTop(caretLine), lineHeight: `${effectiveLineHeight}px` }}
          >
            {caretBlame.author} · {blameRelDate(caretBlame.author_time)} · {caretBlame.summary}
          </div>
        )}
      </div>
      {onFollowLink && <LinkOpenHint at={linkTip} />}
      {acStatus && (
        <div className="file-viewer-ac-status" role="status">
          {/* A trailing "…" marks an in-flight request — show a spinner. */}
          {acStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {acStatus}
        </div>
      )}
      {grammarStatus && (
        <div className="file-viewer-grammar-status" role="status">
          {grammarStatus.endsWith("…") && (
            <span className="file-viewer-ac-spinner" aria-hidden="true" />
          )}
          {grammarStatus}
        </div>
      )}
      {grammarTip && (
        <div
          className={`file-viewer-grammar-tip cat-${grammarTip.range.issue.category}`}
          style={{ left: grammarTip.left, top: grammarTip.top }}
          role="tooltip"
          onMouseEnter={cancelGrammarTipClose}
          onMouseLeave={scheduleGrammarTipClose}
        >
          <div className="file-viewer-grammar-tip-cat">{grammarTip.range.issue.category}</div>
          {grammarTip.range.issue.message && (
            <div className="file-viewer-grammar-tip-msg">{grammarTip.range.issue.message}</div>
          )}
          {grammarTip.range.issue.suggestion && (
            <button
              type="button"
              className="file-viewer-grammar-tip-fix"
              // mousedown keeps the textarea from stealing focus before the click.
              onMouseDown={(e) => { e.preventDefault(); applyGrammarFix(grammarTip.range); }}
            >
              Fix → <span className="file-viewer-grammar-tip-sugg">{grammarTip.range.issue.suggestion}</span>
            </button>
          )}
        </div>
      )}
      {/* Blame hovercard (#blame): full attribution for the hovered gutter cell. */}
      {blameTip && (() => {
        const b = blame?.get(blameTip.line);
        if (!b || isUncommitted(b)) return null;
        return (
          <div
            className="file-viewer-blame-tip"
            style={{ left: blameTip.left, top: blameTip.top }}
            role="tooltip"
          >
            <div className="file-viewer-blame-tip-head">
              <span className="file-viewer-blame-tip-hash">{b.short}</span>
              <span className="file-viewer-blame-tip-author">{b.author}</span>
            </div>
            <div className="file-viewer-blame-tip-date">{blameRelDate(b.author_time)} ago</div>
            <div className="file-viewer-blame-tip-summary">{b.summary}</div>
          </div>
        );
      })()}
      {/* #45 context files: a button to attach project files plus chips for the
          attached ones, shown only when autocomplete is enabled for this type. */}
      {autocomplete?.enabled && (
        <div className="file-viewer-ac-context">
          <button
            type="button"
            className="file-viewer-ac-context-add"
            onClick={() => setAcPicker(true)}
            title="Add a project file as autocomplete context"
          >
            + Context{contextFiles.length ? ` (${contextFiles.length})` : ""}
          </button>
          {contextFiles.map((f) => (
            <span key={f.path} className="file-viewer-ac-context-chip" title={f.rel}>
              {f.rel.split("/").pop()}
              <button
                type="button"
                aria-label={`Remove ${f.rel} from context`}
                onClick={() => removeContextFile(f.path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {acPicker && (
        <ContextFilePicker
          projectDir={acProjectDir}
          attached={contextFiles.map((f) => f.rel)}
          onPick={(rel) => void addContextFile(rel)}
          onClose={() => setAcPicker(false)}
        />
      )}
      {compl && (
        <ul
          className={`file-viewer-tex-compl${compl.ctx.kind === "cite" ? " is-cite" : ""}`}
          role="listbox"
          style={{ left: compl.pos.left, top: compl.pos.top + compl.pos.height }}
        >
          {compl.items.map((it, i) => (
            <li
              key={it.value + i}
              role="option"
              aria-selected={i === compl.index}
              ref={i === compl.index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              className={`file-viewer-tex-compl-item${i === compl.index ? " active" : ""}`}
              // mousedown (not click) + preventDefault so the textarea keeps focus
              // — otherwise the blur handler would close the dropdown first.
              onMouseDown={(e) => { e.preventDefault(); acceptCompl(it.value); }}
              onMouseEnter={() => setCompl((c) => (c ? { ...c, index: i } : c))}
            >
              <span className="file-viewer-tex-compl-key">{it.value}</span>
              {it.detail && <span className="file-viewer-tex-compl-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {findOpen && (
        <div className="file-viewer-find" role="search">
          <div className="file-viewer-find-row">
            {/* Chevron expands/collapses the replace row from a find-only bar. */}
            <button
              className={`file-viewer-find-toggle${replaceOpen ? " active" : ""}`}
              onClick={() => setReplaceOpen((v) => !v)}
              aria-pressed={replaceOpen}
              aria-label={replaceOpen ? "Hide replace" : "Show replace"}
              title={replaceOpen ? "Hide replace" : "Show replace (Ctrl+R)"}
            >
              {replaceOpen ? "▾" : "▸"}
            </button>
            <input
              ref={findInputRef}
              className="file-viewer-find-input"
              type="text"
              value={query}
              placeholder="Find"
              aria-label="Find"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <span className="file-viewer-find-count" aria-live="polite">
              {matches.length > 0 ? `${current + 1}/${matches.length}` : query ? "0/0" : ""}
            </span>
            <button
              className={`file-viewer-find-btn${caseSensitive ? " active" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-pressed={caseSensitive}
              title="Match case"
              aria-label="Match case"
            >
              Aa
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(-1)}
              disabled={matches.length === 0}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={() => goToMatch(1)}
              disabled={matches.length === 0}
              title="Next match (Enter)"
              aria-label="Next match"
            >
              ↓
            </button>
            <button
              className="file-viewer-find-btn"
              onClick={closeFind}
              title="Close (Esc)"
              aria-label="Close find"
            >
              ✕
            </button>
          </div>
          {replaceOpen && (
            <div className="file-viewer-find-row file-viewer-replace-row">
              <input
                ref={replaceInputRef}
                className="file-viewer-find-input"
                type="text"
                value={replaceWith}
                placeholder="Replace"
                aria-label="Replace with"
                spellCheck={false}
                onChange={(e) => setReplaceWith(e.target.value)}
                onKeyDown={onReplaceKeyDown}
              />
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceCurrent}
                disabled={matches.length === 0}
                title="Replace current match (Enter)"
                aria-label="Replace"
              >
                Replace
              </button>
              <button
                className="file-viewer-find-btn file-viewer-replace-btn"
                onClick={replaceAll}
                disabled={matches.length === 0}
                title="Replace all matches (Ctrl+Enter)"
                aria-label="Replace all"
              >
                All
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Save control shared by the editable viewers (#47). Shows a state ICON rather
 * than text: a spinner while saving, a filled disk with a dot when there are
 * unsaved edits, and a check when clean. `aria-label="Save"` keeps it findable.
 */
export function SaveButton({
  isDirty,
  saving,
  save,
}: {
  isDirty: boolean;
  saving: boolean;
  save: () => void;
}) {
  const icon = saving ? (
    <span className="file-viewer-save-spinner" aria-hidden="true" />
  ) : isDirty ? (
    <span className="file-viewer-save-icon dirty" aria-hidden="true">●</span>
  ) : (
    <span className="file-viewer-save-icon clean" aria-hidden="true">✓</span>
  );
  return (
    <button
      className={`file-viewer-save${isDirty ? " is-dirty" : ""}${saving ? " is-saving" : ""}`}
      onClick={save}
      disabled={!isDirty || saving}
      aria-label="Save"
      title={saving ? "Saving…" : isDirty ? "Save (Ctrl+S)" : "No unsaved changes"}
    >
      {icon}
    </button>
  );
}

/** Print button shared by every content viewer. Renders the viewer's content to
 *  a clean paginated document and hands it to the platform print dialog (which
 *  offers "Save as PDF") — see `lib/viewers/print`. `busy` covers async sources
 *  like the PDF viewer, which rasterises its pages before printing. */
function PrintButton({
  onPrint,
  busy = false,
  disabled = false,
}: {
  onPrint: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`file-viewer-print${busy ? " is-busy" : ""}`}
      onClick={onPrint}
      disabled={disabled || busy}
      title={busy ? "Preparing…" : "Print"}
      aria-label="Print"
    >
      {busy ? <span className="file-viewer-save-spinner" aria-hidden="true" /> : "🖨"}
    </button>
  );
}

/** Undo/redo toolbar buttons shared by the editable viewers (#46). */
export function UndoRedoButtons({
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  return (
    <div className="file-viewer-history" role="group" aria-label="Edit history">
      <button
        className="file-viewer-history-btn"
        onClick={undo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
      >
        ↶
      </button>
      <button
        className="file-viewer-history-btn"
        onClick={redo}
        disabled={!canRedo}
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        ↷
      </button>
    </div>
  );
}

// ── Per-format extras: format, validation, preview, markup toolbar ───────────

/**
 * "Format document" support for the editable text viewers. JSON is prettified
 * in-process; every other recognised type shells out to an external formatter
 * (prettier/black/rustfmt/gofmt) via the backend, which is probed once per path
 * so the button can disable itself when no tool is installed. A formatted result
 * is written back through `setDraft`, so it lands as one undo step.
 */
function useFormatter(path: string, draft: string, setDraft: (v: string) => void) {
  const lang = useMemo(() => formatLangForPath(path), [path]);
  const inProcess = useMemo(() => isInProcessJson(path), [path]);
  const enabled = inProcess || lang != null;
  // JSON (in-process) is always available; an external formatter is probed.
  const [available, setAvailable] = useState(inProcess);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!lang) {
      setAvailable(inProcess);
      return;
    }
    let cancelled = false;
    invoke<boolean>("formatter_available", { lang, path })
      .then((ok) => { if (!cancelled) setAvailable(inProcess || ok); })
      .catch(() => { if (!cancelled) setAvailable(inProcess); });
    return () => { cancelled = true; };
  }, [lang, path, inProcess]);

  // Auto-dismiss a finished status after a few seconds.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 6000);
    return () => window.clearTimeout(id);
  }, [status]);

  const run = useCallback(async () => {
    if (busy) return;
    const text = draftRef.current;
    setStatus(null);
    if (inProcess) {
      const res = formatJsonText(text);
      if (res.ok) {
        if (res.text !== text) setDraft(res.text);
      } else {
        setStatus(`Can't format: ${res.error}`);
      }
      return;
    }
    if (!lang) return;
    setBusy(true);
    try {
      const out = await invoke<string>("format_source", { text, lang, path });
      if (out !== text) setDraft(out);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("formatter-unavailable")) {
        setAvailable(false);
        setStatus("No formatter installed for this file type");
      } else {
        setStatus(msg.length > 240 ? `${msg.slice(0, 240)}…` : msg);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, inProcess, lang, path, setDraft]);

  return { enabled, available, busy, status, run };
}

/** "Format" toolbar button; disabled when no formatter is available or while a
 *  format is in flight. Keeps editor focus so the document stays the target. */
function FormatButton({
  available,
  busy,
  run,
}: {
  available: boolean;
  busy: boolean;
  run: () => void;
}) {
  return (
    <button
      className="file-viewer-format-btn"
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      disabled={!available || busy}
      title={available ? "Format document" : "No formatter found for this file type"}
      aria-label="Format document"
    >
      {busy ? <span className="file-viewer-save-spinner" aria-hidden="true" /> : "Format"}
    </button>
  );
}

interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

/** Debounced backend syntax check for JSON/YAML; returns the first parse error
 *  (or null when valid / not a checked type). Re-runs as the draft changes. */
function useSyntaxCheck(path: string, draft: string, loaded: boolean): SyntaxIssue | null {
  const lang = useMemo(() => validationLangForPath(path), [path]);
  const [issue, setIssue] = useState<SyntaxIssue | null>(null);
  useEffect(() => {
    if (!lang || !loaded) {
      setIssue(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      invoke<SyntaxIssue | null>("check_syntax", { text: draft, lang })
        .then((r) => { if (!cancelled) setIssue(r ?? null); })
        .catch(() => { if (!cancelled) setIssue(null); });
    }, 500);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [lang, draft, loaded]);
  return lang ? issue : null;
}

/** Inline parse-error banner for JSON/YAML, with a jump to the offending line. */
function ValidationBanner({
  issue,
  onJump,
}: {
  issue: SyntaxIssue | null;
  onJump: (line: number, column: number) => void;
}) {
  if (!issue) return null;
  const where = issue.line
    ? ` (line ${issue.line}${issue.column ? `, col ${issue.column}` : ""})`
    : "";
  return (
    <div className="file-viewer-validation" role="alert">
      <span className="file-viewer-validation-dot" aria-hidden="true" />
      <span className="file-viewer-validation-msg">
        {issue.message}
        {where}
      </span>
      {issue.line > 0 && (
        <button
          className="file-viewer-validation-jump"
          onClick={() => onJump(issue.line, issue.column)}
        >
          Go to line
        </button>
      )}
    </div>
  );
}

/** Reusable Preview/Edit (Source) segmented toggle, styled like the existing
 *  markdown mode buttons. */
function ModeToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="file-viewer-modes">
      {options.map((o) => (
        <button
          key={o.value}
          className={`file-viewer-mode${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rendered-preview pane for HTML/SVG/CSS — a fully sandboxed (`sandbox=""`,
 *  no scripts) iframe so even a hostile file is inert. CSS is applied to a small
 *  sample document; HTML/SVG render their own source. */
function RenderedPreview({
  kind,
  content,
  fileName,
}: {
  kind: PreviewKind;
  content: string;
  fileName: string;
}) {
  const doc = useMemo(() => buildPreviewDoc(kind, content), [kind, content]);
  return (
    <iframe
      // sandbox="" is intentional and load-bearing: the most restrictive
      // sandbox, so no script in the file can run.
      sandbox=""
      srcDoc={doc}
      title={`Preview of ${fileName}`}
      className="file-viewer-html-frame"
      style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
    />
  );
}

/** Markdown editing toolbar (#md-toolbar): inline/structural formatting plus a
 *  generated table of contents, applied through the editor's imperative API so
 *  each action is one undo step. Buttons `preventDefault` on mousedown so the
 *  editor keeps its selection as the action's target. */
function MarkdownToolbar({ api }: { api: React.MutableRefObject<EditorApi | null> }) {
  const act = (fn: (v: string, s: number, e: number) => EditResult) => () =>
    api.current?.applyEdit(fn);
  const btn = (label: React.ReactNode, title: string, fn: (v: string, s: number, e: number) => EditResult) => (
    <button
      className="file-viewer-md-btn"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={act(fn)}
    >
      {label}
    </button>
  );
  return (
    <div className="file-viewer-md-toolbar" role="group" aria-label="Formatting">
      {btn(<b>B</b>, "Bold", (v, s, e) => toggleInline(v, s, e, "**"))}
      {btn(<i>I</i>, "Italic", (v, s, e) => toggleInline(v, s, e, "_"))}
      {btn(<span style={{ fontFamily: "var(--font-mono, monospace)" }}>{"<>"}</span>, "Inline code", (v, s, e) => toggleInline(v, s, e, "`"))}
      {btn("H", "Cycle heading", (v, s) => cycleHeading(v, s))}
      {btn("🔗", "Link", (v, s, e) => makeLink(v, s, e))}
      {btn("•", "Bulleted list", (v, s, e) => toggleLinePrefix(v, s, e, "- "))}
      {btn("TOC", "Insert table of contents", (v, s, e) => {
        const toc = generateToc(v);
        const ins = toc ? `${toc}\n` : "";
        return { value: v.slice(0, s) + ins + v.slice(e), selStart: s, selEnd: s + ins.length };
      })}
    </div>
  );
}

/** Resolve the per-type viewer prefs for an InternalViewer from settings (#48). */
function useViewerPref(type: InternalViewer) {
  return useSettingsStore((s) => s.settings?.viewer_prefs?.[type]);
}

/** What {@link useTabAiPrefs} returns: the effective autocomplete/grammar config
 *  for the editor, plus the current control state + setters for the in-tab UI. */
export interface TabAiPrefs {
  ac: { enabled: boolean; preferred?: string; mode: AutocompleteMode };
  gc: { enabled: boolean; preferred?: string };
  autocomplete: boolean;
  grammar: boolean;
  mode: AutocompleteMode;
  toggleAutocomplete: () => void;
  toggleGrammar: () => void;
  setMode: (m: AutocompleteMode) => void;
}

/**
 * Tab-local AI-assist prefs (#45). Each editor tab gets its OWN autocomplete
 * on/off, completion-length mode, and grammar on/off, overriding the per-type
 * `viewer_prefs` default for that tab only. The override is seeded once from the
 * tab's persisted `viewerState` and written back there (like scroll/zoom), so it
 * survives reopening the file and an Eldrun restart. Until the user touches a
 * control, the value tracks the per-type setting reactively; once toggled, that
 * tab pins its own value. The `preferred` model for each task is its 🧠-menu tag
 * (`ollama_roles.autocomplete` / `.grammar`), falling back to `ollama_model`.
 */
function useTabAiPrefs(tabKey: string | undefined, type: InternalViewer): TabAiPrefs {
  const pref = useViewerPref(type);
  // Per-task model preference (🧠 menu role chips): autocomplete and grammar can
  // each pin a different loaded model, falling back to the default `ollama_model`
  // when that task has no explicit assignment. Resolved against the resident set
  // at trigger time (see the request paths above).
  const defaultModel = useSettingsStore((s) => s.settings?.ollama_model as string | undefined);
  const acRole = useSettingsStore((s) => s.settings?.ollama_roles?.autocomplete as string | undefined);
  const gcRole = useSettingsStore((s) => s.settings?.ollama_roles?.grammar as string | undefined);
  const acPreferred = acRole ?? defaultModel;
  const gcPreferred = gcRole ?? defaultModel;
  const defAutocomplete = pref?.autocomplete === true;
  const defGrammar = pref?.grammar_check === true;
  const defMode: AutocompleteMode = AC_MODES.includes(pref?.autocomplete_mode as AutocompleteMode)
    ? (pref!.autocomplete_mode as AutocompleteMode)
    : "sentence";

  // Seed the tab-local override once from the persisted viewerState. `undefined`
  // for a field means "no override yet" → fall through to the per-type default.
  const [override, setOverride] = useState<{
    autocomplete?: boolean;
    grammar?: boolean;
    mode?: AutocompleteMode;
  }>(() => {
    const vs = seedViewerState(tabKey);
    return { autocomplete: vs?.autocomplete, grammar: vs?.grammarCheck, mode: vs?.autocompleteMode };
  });

  const persist = useCallback(
    (patch: ViewerState) => {
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, patch);
    },
    [tabKey],
  );

  const autocomplete = override.autocomplete ?? defAutocomplete;
  const grammar = override.grammar ?? defGrammar;
  const mode = override.mode ?? defMode;

  const toggleAutocomplete = useCallback(() => {
    setOverride((o) => {
      const next = !(o.autocomplete ?? defAutocomplete);
      persist({ autocomplete: next });
      return { ...o, autocomplete: next };
    });
  }, [persist, defAutocomplete]);
  const toggleGrammar = useCallback(() => {
    setOverride((o) => {
      const next = !(o.grammar ?? defGrammar);
      persist({ grammarCheck: next });
      return { ...o, grammar: next };
    });
  }, [persist, defGrammar]);
  const setMode = useCallback(
    (m: AutocompleteMode) => {
      persist({ autocompleteMode: m });
      setOverride((o) => ({ ...o, mode: m }));
    },
    [persist],
  );

  return {
    ac: { enabled: autocomplete, preferred: acPreferred, mode },
    gc: { enabled: grammar, preferred: gcPreferred },
    autocomplete,
    grammar,
    mode,
    toggleAutocomplete,
    toggleGrammar,
    setMode,
  };
}

/**
 * Whether at least one local (Ollama) model is currently loaded into memory.
 * Both AI-assist features the controls expose (autocomplete + grammar) run only
 * against a resident model, so the controls hide themselves entirely when none
 * is loaded. Mirrors the lamp logic in `LocalModelMenu`: `ollama_status` is
 * `"loaded"` iff `/api/ps` reports a resident model. Polled on the same 5s
 * cadence as the 🧠 menu so the controls appear/disappear within a few seconds
 * of a model being warmed or unloaded out of band.
 */
function useLocalModelLoaded(): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      invoke<"stopped" | "idle" | "loaded">("ollama_status")
        .then((s) => {
          if (!cancelled) setLoaded(s === "loaded");
        })
        .catch(() => {
          if (!cancelled) setLoaded(false);
        });
    void check();
    const id = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return loaded;
}

/**
 * In-tab AI-assist controls for the editable viewers (#45): an Autocomplete
 * on/off toggle with a length-mode picker (Sentence/Block/Scope), and a Grammar
 * on/off toggle. Both are local-only (Ollama). The state is tab-local (see
 * {@link useTabAiPrefs}) — toggling here affects only this tab. Rendered in the
 * viewer header next to the font/undo/save controls. Hidden entirely while no
 * local model is loaded into memory, since neither feature can run then.
 */
function EditorAiControls({ ai }: { ai: TabAiPrefs }) {
  const modelLoaded = useLocalModelLoaded();
  if (!modelLoaded) return null;
  return (
    <div className="file-viewer-ai-controls" role="group" aria-label="AI assist">
      <button
        type="button"
        className={`file-viewer-ai-btn${ai.autocomplete ? " active" : ""}`}
        onClick={ai.toggleAutocomplete}
        aria-pressed={ai.autocomplete}
        title={
          ai.autocomplete
            ? "Local autocomplete is on (Ctrl+Space) — click to disable"
            : "Local autocomplete is off — click to enable (needs a loaded local model)"
        }
      >
        Autocomplete
      </button>
      {ai.autocomplete && (
        <Dropdown
          className="file-viewer-ai-mode"
          value={ai.mode}
          title="Completion length (Shift+Tab cycles it while a suggestion is showing)"
          onChange={(v) => ai.setMode(v as AutocompleteMode)}
          options={[
            { value: "sentence", label: "Sentence" },
            { value: "block", label: "Block" },
            { value: "scope", label: "Scope" },
          ]}
        />
      )}
      <button
        type="button"
        className={`file-viewer-ai-btn${ai.grammar ? " active" : ""}`}
        onClick={ai.toggleGrammar}
        aria-pressed={ai.grammar}
        title={
          ai.grammar
            ? "Local grammar check is on — click to disable"
            : "Local grammar check is off — click to enable (needs a loaded local model)"
        }
      >
        Grammar
      </button>
    </div>
  );
}

// Code-editor font sizing. The default matches the .file-viewer-code CSS metrics
// (12px / 18px); the line-height tracks the font at a fixed 1.5 ratio so the
// gutter and overlay layers stay aligned at any size.
export const EDITOR_FONT_DEFAULT = 12;
export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 32;
const EDITOR_LINE_RATIO = 1.5;
export const clampFontSize = (n: number) =>
  Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(n)));

/** Shared Ctrl/Cmd+wheel handler for the text viewers (code + markdown): scroll
 *  up grows, down shrinks the font, mirroring the browser zoom gesture and the
 *  Ctrl +/− keyboard shortcuts. A plain wheel (no modifier) falls through to
 *  native scrolling. Typed structurally so both native and synthetic wheel
 *  events satisfy it. */
function onCtrlWheelFont(
  e: Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY"> & {
    preventDefault(): void;
  },
  inc?: () => void,
  dec?: () => void,
) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.deltaY < 0) inc?.();
  else if (e.deltaY > 0) dec?.();
}

/** Bind `handler` as a NON-passive `wheel` listener through the returned callback
 *  ref. React registers its synthetic `onWheel` passively at the document root,
 *  so `preventDefault()` inside a React `onWheel` is ignored: a Ctrl+wheel zoom
 *  can't stop the element from scrolling, so it scrolls to its limit and only
 *  then does the zoom visibly "take". Attaching the listener ourselves with
 *  `{ passive: false }` lets `preventDefault()` cancel the scroll, so Ctrl+wheel
 *  zooms immediately and never scrolls. The callback ref re-binds cleanly across
 *  mount/unmount (e.g. conditionally-rendered viewports). */
export function useNonPassiveWheel(handler: (e: WheelEvent) => void) {
  const cb = useRef(handler);
  cb.current = handler;
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (el) {
      const listener = (e: WheelEvent) => cb.current(e);
      el.addEventListener("wheel", listener, { passive: false });
      detach.current = () => el.removeEventListener("wheel", listener);
    }
  }, []);
}

/**
 * Per-TAB editor font size (text-size +/− control, #48). The zoom is tab-local:
 * changing it resizes only this viewer tab, not every other tab of the same
 * type. The size is seeded once from the tab's persisted `viewerState.fontSize`
 * and written back there (like scroll/zoom), so it survives reopening the file
 * and an Eldrun restart. Until the user zooms this tab it tracks the per-type
 * `viewer_prefs[type].font_size` default reactively; once zoomed, the tab pins
 * its own size. `reset` clears the override, dropping back to that default.
 */
function useEditorFontSize(tabKey: string | undefined, type: InternalViewer) {
  const pref = useViewerPref(type);
  const typeDefault = clampFontSize(pref?.font_size ?? EDITOR_FONT_DEFAULT);

  // Tab-local override, seeded once from the persisted viewerState. `undefined`
  // means "no override yet" → fall through to the per-type default above.
  const [override, setOverride] = useState<number | undefined>(
    () => seedViewerState(tabKey)?.fontSize,
  );
  const fontSize = clampFontSize(override ?? typeDefault);

  const persist = useCallback(
    (size: number | undefined) => {
      setOverride(size);
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, { fontSize: size });
    },
    [tabKey],
  );
  const setFontSize = useCallback(
    (next: number) => persist(clampFontSize(next)),
    [persist],
  );

  return {
    fontSize,
    lineHeight: Math.round(fontSize * EDITOR_LINE_RATIO),
    // True once this tab has set its own size — lets surfaces with their own
    // default (the markdown preview) leave it alone until then.
    isCustom: override != null,
    inc: useCallback(() => setFontSize(fontSize + 1), [setFontSize, fontSize]),
    dec: useCallback(() => setFontSize(fontSize - 1), [setFontSize, fontSize]),
    // Clear the tab override so it falls back to the per-type default.
    reset: useCallback(() => persist(undefined), [persist]),
  };
}

/** A−/A+ text-size control for the code editors, mirroring the image/PDF zoom
 *  group. Reuses the `.file-viewer-zoom-btn` styling. */
function FontSizeControls({
  fontSize,
  inc,
  dec,
  reset,
}: {
  fontSize: number;
  inc: () => void;
  dec: () => void;
  reset: () => void;
}) {
  return (
    <div className="file-viewer-zoom file-viewer-fontsize" role="group" aria-label="Text size">
      <button
        className="file-viewer-zoom-btn"
        onClick={dec}
        disabled={fontSize <= EDITOR_FONT_MIN}
        title="Decrease text size (Ctrl+−)"
        aria-label="Decrease text size"
      >
        A−
      </button>
      <button
        className="file-viewer-zoom-level file-viewer-fontsize-level"
        onClick={reset}
        title="Reset text size (Ctrl+0)"
        aria-label="Reset text size"
      >
        {fontSize}
      </button>
      <button
        className="file-viewer-zoom-btn"
        onClick={inc}
        disabled={fontSize >= EDITOR_FONT_MAX}
        title="Increase text size (Ctrl++)"
        aria-label="Increase text size"
      >
        A+
      </button>
    </div>
  );
}

/**
 * In-tab code editor for plain-text/source files. A monospace textarea with a
 * scroll-synced line-number gutter, Tab/Shift+Tab indentation, and Ctrl/Cmd+S
 * (or the Save button) to write the file back to disk.
 */
/** Subscribe an editor for `path` to pending SyncTeX reverse-search jumps,
 *  yielding the `gotoLine`/`onGotoApplied` props for `CodeEditor`. */
function useEditorJump(path: string) {
  const req = useEditorJumpStore((s) => s.requestsByPath[path] ?? null);
  const consume = useEditorJumpStore((s) => s.consume);
  const onGotoApplied = useCallback(() => consume(path), [consume, path]);
  // Advertise this editor to reverse search so a Ctrl+click in the PDF — even in
  // a detached window whose tabs never reach `useTabsStore` — scrolls it here
  // instead of being delegated to the main window (#42).
  useEffect(() => {
    registerEditor(path);
    return () => unregisterEditor(path);
  }, [path]);
  return {
    gotoLine: req ? { line: req.line, column: req.column, nonce: req.nonce } : undefined,
    onGotoApplied,
  };
}

/** One source line's git-blame attribution; mirrors the Rust `GitBlameLine`
 *  (snake_case, read verbatim). */
interface BlameLine {
  line_no: number;
  hash: string;
  short: string;
  author: string;
  author_time: number;
  summary: string;
}

/** True for git's working-tree "Not Committed Yet" pseudo-commit (all-zeros or
 *  empty sha) — those lines get no attribution / hovercard. */
function isUncommitted(b: BlameLine): boolean {
  return b.hash === "" || /^0+$/.test(b.hash);
}

/** Compact relative age ("now", "3d", "2mo", "5y") from a unix epoch (seconds). */
function blameRelDate(epochSecs: number): string {
  if (!epochSecs) return "";
  const secs = Math.max(0, Date.now() / 1000 - epochSecs);
  const day = 86400;
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < day) return `${Math.floor(secs / 3600)}h`;
  if (secs < day * 30) return `${Math.floor(secs / day)}d`;
  if (secs < day * 365) return `${Math.floor(secs / (day * 30))}mo`;
  return `${Math.floor(secs / (day * 365))}y`;
}

/** Shorten an author for the narrow gutter ("Ada Lovelace" → "A. Lovelace"). */
function authorAbbrev(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) return name;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** Fetches per-line git blame for `path` when `enabled`, keyed by 1-based line
 *  number. Resolves the owning project directory exactly like the autocomplete
 *  path (longest project dir that prefixes `path`, falling back to the active
 *  project) and calls the backend `git_blame` — which dispatches local vs remote
 *  (SSH) transparently. A non-repo dir, a disconnected remote, or any error
 *  yields an empty map (blame just shows nothing); it never throws. */
function useBlame(path: string, enabled: boolean): Map<number, BlameLine> {
  const [byLine, setByLine] = useState<Map<number, BlameLine>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setByLine(new Map());
      return;
    }
    const { projects, activeId } = useProjectsStore.getState();
    let projectDir = "";
    for (const p of projects) {
      const dir = resolveProjectDirectory(p);
      if (dir && isPathWithin(path, dir) && dir.length > projectDir.length) projectDir = dir;
    }
    if (!projectDir) {
      const active = projects.find((p) => p.id === activeId);
      projectDir = active ? resolveProjectDirectory(active) : "";
    }
    if (!projectDir) {
      setByLine(new Map());
      return;
    }
    const relPath = relFromAbs(projectDir, path);
    let cancelled = false;
    invoke<BlameLine[]>("git_blame", { projectDir, relPath })
      .then((lines) => {
        if (cancelled) return;
        const map = new Map<number, BlameLine>();
        for (const l of lines) map.set(l.line_no, l);
        setByLine(map);
      })
      .catch(() => {
        if (!cancelled) setByLine(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return byLine;
}

/** "Blame" toolbar toggle. When active the code editor paints a per-line blame
 *  column in the gutter plus a faint current-line inline annotation. */
function BlameButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  return (
    <button
      className={`file-viewer-format-btn file-viewer-blame-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? "Hide git blame" : "Show git blame"}
      aria-label="Toggle git blame"
      aria-pressed={active}
    >
      Blame
    </button>
  );
}

/**
 * The editor's debug breakpoints (#py) — the gutter's red dots.
 *
 * Two things make this more than a `Set<number>`:
 *
 *  - **They must survive edits.** A breakpoint names a line, so typing a new
 *    import at the top of the file silently re-points every dot below it at the
 *    wrong statement. Each draft change is therefore diffed against the previous
 *    one and the lines are remapped (`remapBreakpoints`).
 *  - **They must be settable only where pdb can break.** Clicking a blank line or
 *    a comment snaps down to the next executable line rather than setting a
 *    breakpoint pdb would reject at startup (`snapBreakpointLine`).
 *
 * They persist in the tab's `ViewerState`, so they survive closing the file and
 * an Eldrun restart — the same plumbing (and the same `project.json` write) as the
 * reader's scroll position.
 */
function useBreakpoints(
  enabled: boolean,
  draft: string,
  loaded: boolean,
  viewPos: ReturnType<typeof useViewerState>,
) {
  const [lines, setLines] = useState<number[]>(() =>
    enabled ? (viewPos.initial?.breakpoints ?? []) : [],
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The draft the current lines were resolved against. Seeded on first load: the
  // editor's ""→content transition is not an edit, and diffing across it would
  // look like "every line was replaced" and drop every restored breakpoint.
  const prevDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !loaded) return;
    const before = prevDraft.current;
    prevDraft.current = draft;
    if (before === null || before === draft) return;
    setLines((cur) => {
      if (cur.length === 0) return cur;
      const next = remapBreakpoints(before, draft, cur);
      // Keep the identity stable when nothing moved, so the gutter doesn't
      // re-render on every keystroke.
      return next.length === cur.length && next.every((l, i) => l === cur[i]) ? cur : next;
    });
  }, [enabled, loaded, draft]);

  // Persist on change only — never on mount, which would rewrite the tab with the
  // value we just read out of it.
  const persistedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = lines.join(",");
    if (persistedKey.current === null) {
      persistedKey.current = key;
      return;
    }
    if (persistedKey.current === key) return;
    persistedKey.current = key;
    viewPos.persist({ breakpoints: lines });
  }, [enabled, lines, viewPos]);

  const toggle = useCallback((line: number) => {
    setLines((cur) => {
      if (cur.includes(line)) return cur.filter((l) => l !== line);
      const snapped = snapBreakpointLine(draftRef.current, line);
      if (snapped == null) return cur; // nothing executable below — no-op
      if (cur.includes(snapped)) return cur.filter((l) => l !== snapped);
      return [...cur, snapped].sort((a, b) => a - b);
    });
  }, []);

  const set = useMemo(() => new Set(lines), [lines]);
  return { lines, set, toggle };
}

/** Run / Debug (#py). Run executes the file in a fresh terminal tab; Debug does
 *  the same under `pdb`, pre-loaded with the gutter's breakpoints.
 *
 *  Right-clicking Run opens a small popover to type **arguments** (`sys.argv`) —
 *  appended to the command line and reused by every subsequent Run/Debug, so a
 *  plain left-click re-runs with them (the tooltip shows what they are). */
function RunDebugButtons({
  breakpointCount,
  busy,
  showDebug,
  args,
  setArgs,
  onRun,
  onDebug,
}: {
  breakpointCount: number;
  busy: boolean;
  /** Debug (pdb + breakpoint gutter) is behind the experimental gate; Run isn't. */
  showDebug: boolean;
  /** The current argument string, and its setter (right-click popover edits it). */
  args: string;
  setArgs: (v: string) => void;
  onRun: () => void;
  onDebug: () => void;
}) {
  const [argsOpen, setArgsOpen] = useState(false);
  // Local draft so typing doesn't rebuild the run command on every keystroke; it
  // is committed to the shared `args` on Run or when the popover closes.
  const [draft, setDraft] = useState(args);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(() => {
    setDraft(args);
    setArgsOpen(true);
  }, [args]);
  const commit = useCallback(() => {
    setArgs(draft.trim());
    setArgsOpen(false);
  }, [draft, setArgs]);

  // Focus the field when the popover opens, and close it on an outside click or Esc.
  useEffect(() => {
    if (!argsOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) commit();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [argsOpen, commit]);

  const argsHint = args ? ` (args: ${args})` : "";
  return (
    <div className="file-viewer-run-controls" ref={wrapRef}>
      <button
        className="file-viewer-format-btn"
        // Right-click opens the args popover. We act on mousedown, not the
        // contextmenu event: preventing the button's default focus-steal (needed
        // to keep the editor caret) suppresses `contextmenu` under WebKitGTK, so
        // that event never arrives. Left-click still runs via onClick.
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onRun}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={`Run this file in a terminal tab${argsHint}\nRight-click to set arguments`}
        aria-label="Run file"
      >
        ▶ Run{args ? " *" : ""}
      </button>
      {showDebug && (
      <button
        className="file-viewer-format-btn"
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 2) open();
        }}
        onClick={onDebug}
        onContextMenu={(e) => e.preventDefault()}
        disabled={busy}
        title={
          (breakpointCount > 0
            ? `Debug under pdb, breaking on ${breakpointCount} line${
                breakpointCount === 1 ? "" : "s"
              } (click the gutter to set more)`
            : "Debug under pdb — stops at the first line. Click a line number to set a breakpoint.") +
          `${argsHint}\nRight-click to set arguments`
        }
        aria-label="Debug file"
      >
        🐞 Debug
      </button>
      )}
      {argsOpen && (
        <div className="file-viewer-run-args" role="dialog" aria-label="Run arguments">
          <label className="file-viewer-run-args-label">Arguments (sys.argv)</label>
          <input
            ref={inputRef}
            className="file-viewer-run-args-input"
            value={draft}
            spellCheck={false}
            placeholder="--epochs 5 data.csv"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setArgs(draft.trim());
                setArgsOpen(false);
                onRun();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setArgsOpen(false);
              }
            }}
          />
          <div className="file-viewer-run-args-row">
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setArgs(draft.trim());
                setArgsOpen(false);
                onRun();
              }}
            >
              ▶ Run
            </button>
            <button
              type="button"
              className="file-viewer-format-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDraft("");
                setArgs("");
              }}
              disabled={!draft}
              title="Clear arguments"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Compare" toolbar toggle. When active the editor body is replaced by the
 *  three-column compare/merge view (old commit ⇄ live content ⇄ editable result). */
function CompareButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  return (
    <button
      className={`file-viewer-format-btn file-viewer-compare-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? "Close compare view" : "Compare with a previous version"}
      aria-label="Toggle compare view"
      aria-pressed={active}
    >
      Compare
    </button>
  );
}

/**
 * The capability-driven base editor for every text/source file. Beyond the
 * shared code editor (highlight, line numbers, Tab indent, undo/redo, save,
 * autocomplete) it derives per-format extras from the path:
 *   - a "Format" button for prettifiable types (JSON in-process; CSS/HTML/JS/
 *     YAML/Python/Rust/Go via a backend formatter when the tool is installed),
 *   - an inline JSON/YAML validation banner with jump-to-line,
 *   - a Preview ⇄ Edit toggle with a sandboxed rendered preview for HTML, SVG,
 *     and CSS (CSS applied to a sample document).
 * `type` keys the per-type prefs (font size / autocomplete); it is "text" for
 * the generic editor and "html" for HTML files so their settings stay distinct.
 */
function TextView({
  path,
  onOpenExternally,
  tabKey,
  type = "text",
  groupId,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  type?: InternalViewer;
  groupId?: string | null;
}) {
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const ai = useTabAiPrefs(tabKey, type);
  const ac = ai.ac;
  const gc = ai.gc;
  const font = useEditorFontSize(tabKey, type);
  const jump = useEditorJump(path);
  const [showBlame, setShowBlame] = useState(false);
  const blame = useBlame(path, showBlame);
  const [compareOpen, setCompareOpen] = useState(false);
  const viewPos = useViewerState(tabKey);
  // Live scroll offsets for the two views this pane toggles between: the Source
  // code editor (`scrollTop`) and the YAML Tree (`yamlScrollTop`). Held in refs,
  // not only persisted, because the pane stays mounted across the Tree↔Source
  // toggle but each inner view REMOUNTS — and would otherwise seed from
  // `viewPos.initial` (the stale open-time snapshot) and jump there. The ref
  // carries the live position so a switch back lands where the view was left.
  const srcScroll = useRef(viewPos.initial?.scrollTop ?? 0);
  const yamlScroll = useRef(viewPos.initial?.yamlScrollTop ?? 0);
  const persistScroll = useCallback(
    (scrollTop: number) => {
      srcScroll.current = scrollTop;
      viewPos.persist({ scrollTop });
    },
    [viewPos],
  );

  // ── Python (#py): run/debug + breakpoints + go-to-definition ──────────────
  // Run is available for any Python file. Debug (pdb) and the breakpoint gutter
  // that only exists to feed it sit behind the experimental `python_run_debug`
  // flag — off by default, on in debug mode (`lib/experimental.ts`).
  // Go-to-definition is deliberately NOT gated: it reads, it never runs anything.
  const isPy = useMemo(() => isPythonPath(path), [path]);
  const pyDebugEnabled = useExperimental("python_run_debug");
  const pyRun = isPy;
  const pyDebug = isPy && pyDebugEnabled;
  const projectId = useFileScope();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const projectDir = project ? resolveProjectDirectory(project) : "";
  const bp = useBreakpoints(pyDebug, draft, loaded, viewPos);
  const [launching, setLaunching] = useState(false);
  // Arguments typed into the Run button's right-click popover, appended to the
  // command line (see pythonRun.buildRunCommand). Kept on the tab so a re-run — and
  // a Debug launch — reuse them, and shown back in the button's tooltip.
  const [pyArgs, setPyArgs] = useState("");
  // Non-null inside a detached popout → the run terminal must stream into THIS
  // window, not the main tab store (see placeForFocused).
  const fileDrop = useContext(FileDropContext);

  // The tab runs in the project's own scope, not whichever project happens to be
  // active — a viewer keeps working after you switch projects (see FileScopeContext),
  // and its Run button must not fire a terminal into a different project's layout.
  const scope = projectId ?? "root";
  const cwd = runCwd(projectDir, path);

  const launch = useCallback(
    async (go: () => Promise<void>) => {
      setLaunching(true);
      try {
        await go();
      } finally {
        setLaunching(false);
      }
    },
    [],
  );

  // Open the run/debug terminal in the focused subwindow of this project — where
  // the user is looking — rather than beside this tab's group.
  const onRun = useCallback(
    () =>
      void launch(() =>
        runPythonFile({
          file: path,
          projectDir: cwd,
          scope,
          projectId,
          args: pyArgs,
          place: placeForFocused(fileDrop),
        }),
      ),
    [launch, path, cwd, scope, projectId, pyArgs, fileDrop],
  );
  const onDebug = useCallback(
    () =>
      void launch(() =>
        debugPythonFile({
          file: path,
          projectDir: cwd,
          scope,
          projectId,
          breakpoints: bp.lines,
          args: pyArgs,
          place: placeForFocused(fileDrop),
        }),
      ),
    [launch, path, cwd, scope, projectId, bp.lines, pyArgs, fileDrop],
  );

  // Ctrl/Cmd+Click a name to open its `def`/`class` — in this file or in the
  // module it was imported from. `jumpToSource` handles both: it re-uses an open
  // editor when there is one (including the same file, and across a detached
  // window) and otherwise opens the target in this tab's subwindow.
  const followPython = useCallback(
    async (caret: number) => {
      const loc = await resolvePythonDefinition(draft, caret, path, projectDir, async (p) => {
        try {
          return await readFileText(p, projectId);
        } catch {
          return null; // doesn't exist / unreadable — just not this candidate
        }
      });
      if (loc) jumpToSource(loc.path, loc.line, loc.column);
    },
    [draft, path, projectDir, projectId],
  );

  const fmt = useFormatter(path, draft, setDraft);
  const issue = useSyntaxCheck(path, draft, loaded);
  const previewKind = useMemo(() => previewKindForPath(path), [path]);
  // #yaml: for YAML and JSON the "preview" is an editable structure tree rather
  // than a rendered document — it writes back into this very draft (see YamlTree),
  // which is what lets Tree and Source be two views on one text and keeps
  // save/undo/format/validation working across both without either mode knowing
  // about the other. JSON is YAML's flow syntax, so it is the same tree, written
  // back in the stricter dialect (`strict`).
  const isYaml = useMemo(() => isTreePath(path), [path]);
  const jsonStrict = useMemo(() => isJsonPath(path), [path]);
  // HTML/SVG/YAML open in preview; CSS opens in the editor (its preview is a sample).
  const [mode, setMode] = useState<"preview" | "edit">(
    previewKind === "html" || previewKind === "svg" || isYaml ? "preview" : "edit",
  );
  const fileName = basename(path);
  const jumpToLine = useCallback(
    (line: number, column: number) =>
      useEditorJumpStore.getState().requestJump(path, line, column),
    [path],
  );

  const showEditor = (!previewKind && !isYaml) || mode === "edit";
  const wheelRef = useNonPassiveWheel((e) => {
    onCtrlWheelFont(e, font.inc, font.dec);
  });

  // The Tree (and preview) scrolls `.file-viewer-body` itself; the Source editor
  // scrolls its own inner viewport instead (see CodeEditor). Keep a ref to the
  // body alongside the wheel-font ref so the tree's scroll can be persisted and
  // restored on the switch back from Source.
  const bodyEl = useRef<HTMLDivElement | null>(null);
  const bodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyEl.current = el;
      wheelRef(el);
    },
    [wheelRef],
  );
  const treeScrolls = isYaml && !showEditor;
  const scrollRaf = useRef<number | null>(null);
  const onBodyScroll = useCallback(() => {
    if (!treeScrolls) return;
    const el = bodyEl.current;
    if (!el) return;
    yamlScroll.current = el.scrollTop;
    // Coalesce the store write to one per frame — a flick of the wheel must not
    // churn the tabs array (and its debounced disk save) every scroll event.
    if (scrollRaf.current == null) {
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        viewPos.persist({ yamlScrollTop: yamlScroll.current });
      });
    }
  }, [treeScrolls, viewPos]);
  useEffect(
    () => () => {
      if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
    },
    [],
  );
  // Restore the tree's scroll when it (re)mounts — on load, and on switching back
  // from Source. Layout effect so it lands before paint, with no visible jump.
  useLayoutEffect(() => {
    if (treeScrolls && loaded && bodyEl.current) {
      bodyEl.current.scrollTop = yamlScroll.current;
    }
  }, [treeScrolls, loaded]);

  // Print: HTML/SVG/CSS print their rendered preview document; plain text and
  // source print as a wrapped monospace block.
  const handlePrint = useCallback(() => {
    if (previewKind) {
      void printDocument(buildPreviewDoc(previewKind, draft));
      return;
    }
    void printHtmlBody(
      `<pre class="print-pre">${escapeHtml(draft)}</pre>`,
      TEXT_PRINT_CSS,
      fileName,
    );
  }, [previewKind, draft, fileName]);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {(previewKind || isYaml) && (
          <ModeToggle
            value={mode}
            onChange={setMode}
            options={[
              { value: "preview", label: isYaml ? "Tree" : "Preview" },
              {
                value: "edit",
                label: isYaml || previewKind === "svg" ? "Source" : "Edit",
              },
            ]}
          />
        )}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {showEditor && pyRun && (
          <RunDebugButtons
            breakpointCount={bp.lines.length}
            busy={launching}
            showDebug={pyDebug}
            args={pyArgs}
            setArgs={setPyArgs}
            onRun={onRun}
            onDebug={onDebug}
          />
        )}
        {showEditor && <EditorAiControls ai={ai} />}
        {showEditor && fmt.enabled && (
          <FormatButton available={fmt.available} busy={fmt.busy} run={() => void fmt.run()} />
        )}
        {showEditor && (
          <BlameButton active={showBlame} toggle={() => setShowBlame((v) => !v)} />
        )}
        {showEditor && (
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        )}
        {/* The YAML tree edits the text, so its edits are ordinary undo steps —
            the buttons stay live in Tree mode, unlike a read-only preview. */}
        {(showEditor || isYaml) && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      {fmt.status && <div className="file-viewer-status-line">{fmt.status}</div>}
      {(showEditor || isYaml) && <ValidationBanner issue={issue} onJump={jumpToLine} />}
      <div
        className={`file-viewer-body${showEditor ? " file-viewer-code-body" : ""}`}
        ref={bodyRef}
        onScroll={onBodyScroll}
      >
        {!showEditor && (previewKind || isYaml) ? (
          error != null ? (
            <div className="file-viewer-error">{error}</div>
          ) : !loaded ? (
            <div className="file-viewer-loading">Loading…</div>
          ) : isYaml ? (
            // The tree edits the draft in place — the same draft Source shows and
            // Ctrl+S writes, so an edit made here is dirty, undoable and saveable
            // exactly like a typed one.
            <YamlTree
              text={draft}
              onChange={setDraft}
              tabKey={tabKey}
              fontSize={font.isCustom ? font.fontSize : undefined}
              strict={jsonStrict}
            />
          ) : (
            // Preview reflects the live draft, so it tracks unsaved edits.
            <RenderedPreview kind={previewKind!} content={draft} fileName={fileName} />
          )
        ) : compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : (
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            grammarCheck={gc}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            wrap
            gotoLine={jump.gotoLine}
            onGotoApplied={jump.onGotoApplied}
            showBlame={showBlame}
            blame={blame}
            breakpoints={pyDebug ? bp.set : undefined}
            onToggleBreakpoint={pyDebug ? bp.toggle : undefined}
            onFollowLink={isPy ? followPython : undefined}
            linkRanges={isPy ? pythonLinkRanges : undefined}
            // The LIVE offset (not `viewPos.initial`), so re-showing Source after
            // a trip through Tree restores where the editor was, not the stale
            // open-time snapshot.
            initialScrollTop={srcScroll.current}
            onScrollPersist={persistScroll}
            groupId={groupId}
          />
        )}
      </div>
    </div>
  );
}

function MarkdownView({
  path,
  onOpenExternally,
  tabKey,
  groupId,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}) {
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const scope = useFileScope();
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [compareOpen, setCompareOpen] = useState(false);
  const font = useEditorFontSize(tabKey, "markdown");
  const wheelRef = useNonPassiveWheel((e) => onCtrlWheelFont(e, font.inc, font.dec));
  // Proportional scroll-link (preview mode only — edit mode links via CodeEditor's
  // textarea). `.file-viewer-body` is the overflow:auto scroller for the preview.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      wheelRef(el);
      bodyScrollRef.current = el;
    },
    [wheelRef],
  );
  const ai = useTabAiPrefs(tabKey, "markdown");
  const ac = ai.ac;
  const gc = ai.gc;
  const fmt = useFormatter(path, draft, setDraft);
  // Imperative editor handle the formatting toolbar drives (bold/italic/TOC/…).
  const editorApi = useRef<EditorApi | null>(null);
  const viewPos = useViewerState(tabKey);
  const persistScroll = useCallback(
    (scrollTop: number) => viewPos.persist({ scrollTop }),
    [viewPos],
  );
  // Preview always reflects the live draft, so toggling shows unsaved edits.
  const html = useMemo(() => (loaded ? renderMarkdown(draft) : ""), [loaded, draft]);
  // Register the preview scroller only while in preview mode, so it never fights
  // CodeEditor for the same group id (edit mode links via the textarea instead).
  const reportPreviewSync = useScrollSync(mode === "preview" ? groupId : null, bodyScrollRef);

  // After the preview HTML is committed to the DOM, run the mermaid/KaTeX
  // enrichment pass (Dev A): it finds the mermaid code blocks and math
  // placeholders renderMarkdown emitted and renders them in place. Re-runs
  // whenever the rendered HTML changes or we switch back to preview mode.
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== "preview") return;
    const el = previewRef.current;
    if (!el) return;
    void enrichMarkdownDom(el);
  }, [html, mode]);

  // #49/#50: local-file links in the rendered preview open in-app on
  // Ctrl/Cmd+Click (matching the LaTeX editor). A hover hint advertises the
  // shortcut. `linkTip` anchors that hint above the hovered link.
  const [linkTip, setLinkTip] = useState<{ left: number; top: number } | null>(null);

  // #50: inline local images in the preview. The renderer tags relative/absolute
  // image paths as <img.md-img-local data-md-src="…"> (no `src`, since the webview
  // can't load them from the app origin); resolve each against the markdown file's
  // directory, read the bytes, and swap in a Blob URL. URLs are revoked when the
  // rendered html changes or on unmount. Shares `previewRef` with the enrichment
  // pass above — both target the same rendered-preview container.
  useEffect(() => {
    if (mode !== "preview") return;
    const root = previewRef.current;
    if (!root) return;
    const imgs = Array.from(
      root.querySelectorAll<HTMLImageElement>("img.md-img-local[data-md-src]"),
    );
    if (!imgs.length) return;
    let cancelled = false;
    const urls: string[] = [];
    for (const img of imgs) {
      const target = resolveLocalHref(path, img.getAttribute("data-md-src") ?? "");
      if (!target) continue;
      readFileBytes(target, scope)
        .then((bytes) => {
          if (cancelled) return;
          const objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: imageMimeForPath(target) }),
          );
          urls.push(objectUrl);
          img.src = objectUrl;
        })
        .catch(() => { /* missing/unreadable file: leave the alt text showing */ });
    }
    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [html, mode, path, scope]);

  // Print the rendered Markdown. Prefer the live preview DOM (it carries the
  // enriched mermaid/KaTeX output and inlined local images); fall back to a fresh
  // render of the current draft when Edit mode has the preview unmounted.
  const handlePrint = useCallback(() => {
    const inner = previewRef.current?.innerHTML || html || renderMarkdown(draft);
    void printHtmlBody(
      `<div class="markdown-body">${inner}</div>`,
      MARKDOWN_PRINT_CSS,
      basename(path),
    );
  }, [html, draft, path]);

  const onPreviewMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a.file-link") as HTMLElement | null;
    if (!a) {
      setLinkTip((cur) => (cur ? null : cur));
      return;
    }
    const r = a.getBoundingClientRect();
    setLinkTip({ left: r.left, top: r.top });
  }, []);

  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest?.("a.file-link") as HTMLAnchorElement | null;
      if (!a) return;
      // Always stop the anchor's own navigation (it carries target="_blank"); only
      // a follow modifier actually opens the file, mirroring the LaTeX editor.
      e.preventDefault();
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = resolveLocalHref(path, a.getAttribute("href") ?? "");
      if (!target) return;
      openLinkedFile(tabKey, dirname(path), {
        path: target,
        viewer: viewerForPath(target),
        label: basename(target),
      });
    },
    [path, tabKey],
  );

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <div className="file-viewer-modes">
          <button
            className={`file-viewer-mode${mode === "preview" ? " active" : ""}`}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            className={`file-viewer-mode${mode === "edit" ? " active" : ""}`}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
        </div>
        {mode === "edit" && <MarkdownToolbar api={editorApi} />}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {mode === "edit" && <EditorAiControls ai={ai} />}
        {mode === "edit" && fmt.enabled && (
          <FormatButton available={fmt.available} busy={fmt.busy} run={() => void fmt.run()} />
        )}
        {mode === "edit" && (
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        )}
        {mode === "edit" && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      {mode === "edit" && fmt.status && (
        <div className="file-viewer-status-line">{fmt.status}</div>
      )}
      <div
        className={`file-viewer-body${mode === "edit" ? " file-viewer-code-body" : ""}`}
        ref={setBodyRef}
        onScroll={reportPreviewSync}
      >
        {mode === "edit" && compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : mode === "edit" ? (
          // The shared code editor gives markdown the same Tab/undo/save behaviour
          // as the text/tex viewers — and local autocomplete (#45). `wrap` so prose
          // soft-wraps. It renders its own load/error states.
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            grammarCheck={gc}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            wrap
            editorApiRef={editorApi}
            initialScrollTop={viewPos.initial?.scrollTop}
            onScrollPersist={persistScroll}
            groupId={groupId}
          />
        ) : error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <div
            ref={previewRef}
            className="markdown-body"
            // Leave the preview at its CSS default until the user sets a size,
            // then drive the base font-size so headings (em-based) scale with it.
            style={font.isCustom ? { fontSize: `${font.fontSize}px` } : undefined}
            onMouseMove={onPreviewMove}
            onMouseLeave={() => setLinkTip(null)}
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      {mode === "preview" && <LinkOpenHint at={linkTip} />}
    </div>
  );
}

/** Load a file's bytes and expose them as a Blob object URL, used by the image
 *  viewer (<img> sniffs the type). Like the editors/PDF (#43), it polls
 *  `file_mtime` and re-reads the bytes when the file changes on disk, so an image
 *  regenerated by an external tool updates in place. A same-path reload swaps the
 *  URL only once the new bytes are ready (no flash to a loading state); the old
 *  URL is revoked then, and the last URL is revoked on unmount. */
function useBlobUrl(path: string, type: string) {
  const scope = useFileScope();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const lastMtime = useRef<number | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);

  // Reset to the loading state when the path itself changes (a genuine file
  // switch). A same-path reload (a diskVersion bump) keeps the current image up
  // until the fresh bytes arrive, so the view doesn't flash.
  useEffect(() => {
    setUrl(null);
    setError(null);
    lastMtime.current = null;
  }, [path]);

  // Load on mount, path switch, or on-disk change; revoke the previous URL only
  // once its replacement is ready.
  useEffect(() => {
    let cancelled = false;
    readFileBytes(path, scope)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], type ? { type } : undefined);
        const objectUrl = URL.createObjectURL(blob);
        const prev = urlRef.current;
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        if (prev) URL.revokeObjectURL(prev);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, type, diskVersion, scope]);

  // Revoke the last live URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    },
    [],
  );

  // Poll mtime; on an external advance, bump diskVersion to re-read fresh bytes.
  useEffect(() => {
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    const id = setInterval(() => {
      fileMtime(path, scope)
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          setDiskVersion((v) => v + 1);
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, scope]);

  return { url, error };
}


/**
 * The in-tab LaTeX viewer. It always offers the same editable code editor as the
 * plain-text viewer; on top of that, when a TeX engine is on PATH it adds a
 * compile toolbar:
 *   - Compile saves the source first (it's editable) then runs `compile_tex`,
 *     which builds `<stem>.pdf` next to the source. On success the PDF is opened
 *     in its own tab (or the existing PDF tab is refocused) rather than an inline
 *     preview pane — the PDF tab polls the file's mtime, so a recompile reloads
 *     the fresh bytes on its own. On failure the build-log tail is shown with an
 *     expandable full log.
 *   - With no engine available it renders exactly the plain-text editor — no
 *     compile UI — so a TeX-less machine keeps the prior behaviour. While
 *     capability is still loading it shows the editor too, to avoid a flash of a
 *     different layout.
 *   - The engine selector only appears when more than one engine is on PATH;
 *     otherwise the backend default is used (`engine: null`).
 */

/** OS-appropriate command to install a LaTeX/TeX distribution, used by the
 *  one-click "Install LaTeX" prompt shown when no TeX engine is on PATH. These
 *  are best-effort defaults the user can edit in the spawned terminal: MiKTeX on
 *  Windows, MacTeX on macOS (Homebrew), TeX Live on Linux (Debian/Ubuntu apt). */
const TEX_INSTALL_CMD = IS_WINDOWS
  ? "winget install --id MiKTeX.MiKTeX -e"
  : IS_MAC
    ? "brew install --cask mactex-no-gui"
    : "sudo apt-get install -y texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended latexmk";
const TEX_INSTALL_LABEL = IS_WINDOWS ? "Install MiKTeX" : "Install LaTeX";

function TexView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  /** This viewer tab's key, for #50 same-subwindow link routing. */
  tabKey?: string;
}) {
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const scope = useFileScope();
  const ai = useTabAiPrefs(tabKey, "tex");
  const ac = ai.ac;
  const gc = ai.gc;
  const [compareOpen, setCompareOpen] = useState(false);
  const font = useEditorFontSize(tabKey, "tex");
  const viewPos = useViewerState(tabKey);
  const persistScroll = useCallback(
    (scrollTop: number) => viewPos.persist({ scrollTop }),
    [viewPos],
  );

  // Print the .tex source as a wrapped monospace block. (The compiled PDF, once
  // built, opens in the PDF viewer and prints from there.)
  const handlePrint = useCallback(() => {
    void printHtmlBody(
      `<pre class="print-pre">${escapeHtml(draft)}</pre>`,
      TEXT_PRINT_CSS,
      basename(path),
    );
  }, [draft, path]);

  // null while still probing; the editor renders regardless so there is no flash.
  const [cap, setCap] = useState<TexCapability | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTexCapability().then((c) => { if (!cancelled) setCap(c); });
    return () => { cancelled = true; };
  }, []);

  // Ctrl/Cmd+Click a `\input{…}` (or \include/\subfile/\bibliography/
  // \includegraphics/…) to open the referenced file in its own tab, resolved
  // relative to this file. By default it opens in the SAME subwindow as this tab
  // (#50). A bare \includegraphics is resolved by probing the directory.
  const followLink = useCallback(
    async (caret: number): Promise<boolean> => {
      const target = findTexRefAt(draft, caret);
      if (!target) return false;
      const disabled = disabledViewers(
        useSettingsStore.getState().settings?.viewer_prefs,
      );
      const resolved = await resolveTexRefAsync(path, target, disabled);
      if (!resolved) return false;
      const dir = dirname(path) || "/";
      openLinkedFile(tabKey, dir, resolved);
      return true;
    },
    [draft, path, tabKey],
  );

  // #49: decorate every `\input{…}`/`\includegraphics{…}` argument range so it
  // reads as a clickable link in the editor.
  const linkRanges = useCallback((source: string) => texRefRanges(source), []);

  // Chosen engine (only when >1 is available); "" means "let the backend pick".
  const [engine, setEngine] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  // True when the last compile ran with shell-escape (`\write18`) active despite
  // our args never enabling it — a system texmf.cnf / latexmkrc turned it on.
  const [shellEscape, setShellEscape] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState("");
  // Source locations parsed out of the last failed build's log (TeX runs with
  // `-file-line-error`), backing the jump-to-error buttons below.
  const [errors, setErrors] = useState<TexError[]>([]);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  // 0 = never compiled (preview shows a placeholder); each successful compile
  // bumps this to force the PDF blob to refetch the freshly written bytes.
  const [pdfVersion, setPdfVersion] = useState(0);
  // True when the last successful compile's forward-search (caret → PDF) found
  // no location, so the PDF kept its previous position instead of jumping to the
  // cursor. Shown as a transient notice so a SyncTeX miss reads differently from
  // a bug; auto-cleared by the effect below.
  const [syncMiss, setSyncMiss] = useState(false);

  // \ref/\cite key completion: `\label` keys across the document and entry keys
  // from the connected `.bib` file(s), gathered from disk on load. Re-gathered
  // after each compile (a build may add labels / change bib resources). The
  // current file's labels are merged live from the editor draft below so a label
  // just typed is offered without waiting for a re-gather.
  const [gathered, setGathered] = useState<TexCompletions>({ labels: [], cites: [] });
  useEffect(() => {
    let cancelled = false;
    gatherTexCompletions(path, scope)
      .then((c) => { if (!cancelled) setGathered(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope, pdfVersion]);
  const completions = useMemo<TexCompletions>(
    () => ({
      labels: Array.from(new Set([...parseTexLabels(draft), ...gathered.labels])),
      cites: gathered.cites,
    }),
    [draft, gathered],
  );

  // #54 compiler options: an optional output folder (relative to the source or
  // absolute) and extra engine flags (space-separated). The backend filters the
  // flags so none can ever enable shell-escape. UI starts collapsed.
  const [showOptions, setShowOptions] = useState(false);
  const [outDir, setOutDir] = useState("");
  const [extraFlags, setExtraFlags] = useState("");

  // SyncTeX reverse-search target (PDF → here) and the live caret (for forward
  // search on compile). draftRef keeps the latest text for the compile closure.
  const jump = useEditorJump(path);
  const caretRef = useRef(0);
  const onCaret = useCallback((offset: number) => { caretRef.current = offset; }, []);
  // Live caret getter published by the mounted CodeEditor (see `caretApiRef`).
  // Preferred over `caretRef` at compile time because it reads the real cursor,
  // not a snapshot that can be a stale 0 when the editor was never focused.
  const caretApiRef = useRef<(() => number | null) | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The file actually built on Compile: a child `.tex` redirects to its main
  // document (resolve_tex_root). Resolved on load and refreshed after each
  // compile, since compiling the parent may have just recorded the mapping.
  const [root, setRoot] = useState(path);
  useEffect(() => {
    let cancelled = false;
    resolveTexRoot(path).then((r) => { if (!cancelled) setRoot(r); });
    return () => { cancelled = true; };
  }, [path]);
  const isChild = root !== path;
  const rootName = basename(root);
  // Directory the build runs in — error paths in the log are relative to it.
  const rootDir = dirname(root) || "/";

  // Open the compiled PDF as its own tab (it is a real file), reusing the embed
  // viewer. openLinkedFile dedupes against an already-open PDF tab for the same
  // path and routes to the same subwindow as this tab; the PDF pane polls mtime,
  // so a reused tab reloads the freshly compiled bytes on its own.
  const openPdf = useCallback(
    (pdf: string) => {
      const name = basename(pdf);
      const dir = dirname(path) || "/";
      openLinkedFile(tabKey, dir, { path: pdf, viewer: "pdf", label: name });
    },
    [path, tabKey],
  );

  // The PDF this source builds to: the last compile's actual output when known
  // (it honours the #54 out-dir), else the conventional sibling of the built
  // root. Used by on-demand forward search without recompiling.
  const targetPdf = useCallback(
    () => pdfPath ?? root.replace(/\.tex$/i, ".pdf"),
    [pdfPath, root],
  );

  // SyncTeX forward search on demand: map a caret offset in this source to its
  // box in the PDF and reveal/flash it there — without recompiling. Opens (or
  // refocuses) the PDF tab only on a hit, so a miss never spawns a broken tab.
  const forwardSync = useCallback(
    async (caret: number) => {
      const pdf = targetPdf();
      setSyncMiss(false);
      const { line, column } = offsetToLineCol(draftRef.current, caret);
      const phrase = phraseAt(draftRef.current, caret) ?? undefined;
      // Try every spelling SyncTeX might have stored the source under.
      const recs = await synctexViewBest(pdf, path, rootDir, line, column);
      // Pick the record (box / wrapped row) the clicked column lands in.
      const rect = pickSyncRect(recs, sourceColumnFraction(draftRef.current, line, column));
      if (rect) {
        openPdf(pdf);
        // Pass the clicked word + neighbours so the PDF narrows the line box to
        // that exact word, using the phrase to pick the right occurrence.
        usePdfSyncStore.getState().requestReveal(pdf, rect, phrase);
      } else {
        setSyncMiss(true);
      }
    },
    [targetPdf, path, openPdf, rootDir],
  );

  // Ctrl/⌘+click in the editor: follow a `\input{…}`-style reference when the
  // caret sits on one, otherwise forward-sync that caret position into the PDF.
  const onEditorFollow = useCallback(
    async (caret: number) => {
      if (await followLink(caret)) return;
      await forwardSync(caret);
    },
    [followLink, forwardSync],
  );

  const compile = useCallback(async () => {
    if (compiling) return;
    setCompiling(true);
    setCompileError(null);
    setErrors([]);
    setSyncMiss(false);
    // Snapshot the caret synchronously, before any await can let focus change or
    // a blur reset it: prefer the editor's live cursor, falling back to the last
    // reported offset. This is the position forward search reveals in the PDF.
    const caretAtCompile = caretApiRef.current?.() ?? caretRef.current;
    try {
      // The source is editable, so persist any pending edits before building.
      await save();
      // A child file builds its main document instead of the fragment.
      const target = await resolveTexRoot(path);
      setRoot(target);
      // #54: pass the compiler options. The backend filters extra_flags so none
      // can ever enable shell-escape (compile_args_never_enable_shell_escape).
      const flags = extraFlags.trim().split(/\s+/).filter(Boolean);
      const res = await invoke<TexCompileResult>("compile_tex", {
        path: target,
        engine: engine || null,
        outDir: outDir.trim() || null,
        extraFlags: flags.length > 0 ? flags : null,
      });
      setLog(res.log);
      // Surface a shell-escape warning regardless of build success — an external
      // command may have run even if the document then failed to compile.
      setShellEscape(res.shell_escape);
      if (!res.success) {
        const parsed = parseTexErrors(res.log);
        setErrors(parsed);
        const detail = parsed[0]?.message || lastLogLine(res.log);
        setCompileError(detail || "Compilation failed.");
        return;
      }
      setCompileError(null);
      if (res.pdf_path) {
        setPdfPath(res.pdf_path);
        setPdfVersion((v) => v + 1);
        openPdf(res.pdf_path); // open (or refocus) the PDF in its own tab
        // Forward search: reveal & highlight the caret's output position in the
        // PDF. `input` is this edited file even when a parent was built, since
        // the caret lives here. Best-effort — no-op when SyncTeX has no answer.
        const { line, column } = offsetToLineCol(draftRef.current, caretAtCompile);
        const recs = await synctexViewBest(res.pdf_path, path, rootDir, line, column);
        const rect = pickSyncRect(recs, sourceColumnFraction(draftRef.current, line, column));
        if (rect)
          usePdfSyncStore
            .getState()
            .requestReveal(res.pdf_path, rect, phraseAt(draftRef.current, caretAtCompile) ?? undefined);
        // No SyncTeX answer for the caret → the PDF stays where it was. Flag it so
        // the user knows the jump-to-cursor was skipped (a miss, not a failure).
        else setSyncMiss(true);
      }
    } catch (e) {
      setCompileError(String(e));
    } finally {
      setCompiling(false);
    }
  }, [compiling, save, path, engine, outDir, extraFlags, openPdf]);

  // Auto-dismiss the forward-search miss notice a few seconds after it appears.
  useEffect(() => {
    if (!syncMiss) return;
    const id = setTimeout(() => setSyncMiss(false), 4000);
    return () => clearTimeout(id);
  }, [syncMiss]);

  // No engine (or still probing): degrade to exactly the plain-text editor.
  if (!cap || !cap.available) {
    return (
      <div className="file-viewer">
        <ViewerHeader onOpenExternally={onOpenExternally}>
          <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
          <EditorAiControls ai={ai} />
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
          <PrintButton onPrint={handlePrint} disabled={!loaded} />
          <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        </ViewerHeader>
        {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
        {saveError && <div className="file-viewer-error">{saveError}</div>}
        {cap && !cap.available && (
          <div className="tex-install-banner" role="note">
            <span className="tex-install-banner-text">
              No LaTeX engine found — install one to compile this document to a PDF.
            </span>
            <code className="ollama-install-cmd">{TEX_INSTALL_CMD}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              title="Run this command in a new terminal tab"
              onClick={() =>
                runInstallInTab(TEX_INSTALL_LABEL, TEX_INSTALL_CMD, IS_WINDOWS ? "default" : "bash")
              }
            >
              Run in terminal
            </button>
          </div>
        )}
        <div className="file-viewer-body file-viewer-code-body">
          {compareOpen ? (
            <CompareView
              path={path}
              rightText={draft}
              onApply={(merged) => {
                setDraft(merged);
                setCompareOpen(false);
              }}
              onClose={() => setCompareOpen(false)}
            />
          ) : (
            <CodeEditor
              path={path}
              error={error}
              draft={draft}
              setDraft={setDraft}
              loaded={loaded}
              save={() => void save()}
              onFollowLink={onEditorFollow}
              linkRanges={linkRanges}
              undo={undo}
              redo={redo}
              autocomplete={ac}
              grammarCheck={gc}
              texCompletions={completions}
              fontSize={font.fontSize}
              lineHeight={font.lineHeight}
              incFont={font.inc}
              decFont={font.dec}
              resetFont={font.reset}
              gotoLine={jump.gotoLine}
              onGotoApplied={jump.onGotoApplied}
              onCaretChange={onCaret}
              caretApiRef={caretApiRef}
              initialScrollTop={viewPos.initial?.scrollTop}
              onScrollPersist={persistScroll}
              wrap
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      {/* Single header row: the compile controls live alongside Save / Open
          externally rather than on a second toolbar line below. */}
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <button
          className={`file-viewer-tex-compile${compiling ? " is-compiling" : ""}`}
          // mousedown + preventDefault so clicking Compile doesn't blur the
          // editor textarea — the body caret stays put (and visible in a split)
          // instead of vanishing, and forward search still runs from it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void compile()}
          disabled={compiling}
          title={
            isChild
              ? `Save and compile ${rootName} (parent of this file)`
              : "Save and compile to PDF"
          }
        >
          {compiling ? "Compiling…" : isChild ? `Compile ${rootName} ▸` : "Compile ▸"}
        </button>
        {cap.engines.length > 1 && (
          <Dropdown
            className="file-viewer-tex-engine"
            title="LaTeX engine"
            value={engine}
            onChange={setEngine}
            disabled={compiling}
            options={[
              // "" lets the backend pick; label it with the engine it would use
              // (the first installed one, matching the backend's default order).
              { value: "", label: `${cap.engines[0]} (default)` },
              ...cap.engines.map((eng) => ({ value: eng, label: eng })),
            ]}
          />
        )}
        {compiling && <span className="file-viewer-tex-spinner" aria-hidden="true" />}
        <button
          className={`file-viewer-tex-options-toggle${showOptions ? " active" : ""}`}
          onClick={() => setShowOptions((v) => !v)}
          aria-pressed={showOptions}
          title="Compiler options (output folder, extra flags)"
        >
          Options ⚙
        </button>
        {pdfVersion > 0 && pdfPath && (
          <button
            className="file-viewer-tex-open-pdf"
            onClick={() => openPdf(pdfPath)}
            title="Open the compiled PDF in its own tab"
          >
            Open PDF ↗
          </button>
        )}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        <EditorAiControls ai={ai} />
        <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
      </ViewerHeader>
      {compiling && (
        <div className="file-viewer-tex-progress" role="progressbar" aria-label="Compiling">
          <div className="file-viewer-tex-progress-bar" />
        </div>
      )}
      {showOptions && (
        <div className="file-viewer-tex-options" role="group" aria-label="Compiler options">
          <label className="file-viewer-tex-option">
            <span>Output folder</span>
            <input
              type="text"
              value={outDir}
              placeholder="(beside source)"
              onChange={(e) => setOutDir(e.target.value)}
            />
          </label>
          <label className="file-viewer-tex-option">
            <span>Extra flags</span>
            <input
              type="text"
              value={extraFlags}
              placeholder="e.g. -synctex=1 -file-line-error"
              onChange={(e) => setExtraFlags(e.target.value)}
            />
          </label>
          <p className="file-viewer-tex-options-note">
            Shell-escape / <code>\write18</code> flags are always stripped — Eldrun
            never enables them.
          </p>
        </div>
      )}
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {syncMiss && (
        <div className="file-viewer-tex-sync-miss" role="status">
          Compiled — couldn't locate the cursor in the PDF (no SyncTeX match), so
          its position was kept. Put the caret in body text and recompile to jump.
        </div>
      )}
      {shellEscape && (
        <div className="file-viewer-tex-shell-warning" role="alert">
          ⚠ This compile ran with LaTeX shell-escape (<code>\write18</code>) active —
          the document was able to execute shell commands. Eldrun never enables it,
          so a system <code>texmf.cnf</code> or <code>latexmkrc</code> turned it on.
          Only compile <code>.tex</code> files you trust.
        </div>
      )}
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      {compileError && (
        <div className="file-viewer-error file-viewer-tex-log-error">
          <div className="file-viewer-tex-log-line">{compileError}</div>
          {errors.length > 0 && (
            <ul className="file-viewer-tex-errors">
              {errors.map((err, i) => (
                <li key={`${err.file}:${err.line}:${i}`}>
                  <button
                    className="file-viewer-tex-error-jump"
                    title={`Jump to ${err.file}:${err.line}`}
                    onClick={() =>
                      jumpToSource(
                        resolveTexErrorPath(rootDir, err.file),
                        err.line,
                        1,
                      )
                    }
                  >
                    <span className="file-viewer-tex-error-loc">
                      {err.file.split("/").pop()}:{err.line}
                    </span>
                    <span className="file-viewer-tex-error-msg">{err.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {log && (
            <button
              className="file-viewer-tex-log-toggle"
              onClick={() => setShowLog((s) => !s)}
            >
              {showLog ? "Hide log" : "Show full log"}
            </button>
          )}
          {showLog && log && <pre className="file-viewer-tex-log">{log}</pre>}
        </div>
      )}
      <div className="file-viewer-body file-viewer-code-body">
        {compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : (
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            // Ctrl+S in the LaTeX viewer saves and recompiles (compile() persists
            // pending edits first), so the PDF preview tracks the source.
            save={() => void compile()}
            onFollowLink={onEditorFollow}
            linkRanges={linkRanges}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            grammarCheck={gc}
            texCompletions={completions}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            gotoLine={jump.gotoLine}
            onGotoApplied={jump.onGotoApplied}
            onCaretChange={onCaret}
            caretApiRef={caretApiRef}
            initialScrollTop={viewPos.initial?.scrollTop}
            onScrollPersist={persistScroll}
            wrap
          />
        )}
      </div>
    </div>
  );
}

// Exported so GifView shares the exact zoom behavior (steps, bounds) with the
// image viewer.
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;
export const ZOOM_STEP = 1.2;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Zoomable/pannable image viewer. The image is drawn at its natural pixel size
 * and positioned with a CSS transform (`translate(...) scale(...)`, origin 0,0)
 * so a `scale` of 1 means 1:1 (one image pixel per CSS pixel). On load — and on
 * any viewport resize while still "fit" — the view resets to fit the whole image
 * centred in the viewport.
 *
 * Interactions:
 *   - wheel          → zoom toward the cursor
 *   - drag           → pan
 *   - double-click   → toggle between Fit and 100%
 *   - header buttons → − / percent / + / Fit / 1:1
 */
function ImageView({
  path,
  fileName,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const viewPos = useViewerState(tabKey);
  const { url, error } = useBlobUrl(path, "");
  // Print the image, fit to the page. The blob URL resolves in the print iframe
  // because a srcdoc iframe shares this document's origin.
  const handlePrint = useCallback(() => {
    if (!url) return;
    void printHtmlBody(
      `<div class="print-page"><img src="${url}" alt="${escapeHtml(fileName)}"></div>`,
      IMAGE_PRINT_CSS,
      fileName,
    );
  }, [url, fileName]);
  // #annotate (Dev F): when true, an editing overlay covers the viewer letting the
  // user draw on the image and save the result. Gated to raster images we can
  // re-encode to PNG.
  const [annotating, setAnnotating] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Natural (intrinsic) image size in pixels, set on load. The ref mirrors it so
  // an on-disk reload (#68) can tell a same-size content update from a new image.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const naturalRef = useRef<{ w: number; h: number } | null>(null);
  naturalRef.current = natural;
  // View transform: image-pixel scale and top-left offset within the viewport.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // True while the view is the auto-fit baseline, so a viewport resize re-fits.
  const fittedRef = useRef(true);

  const viewportSize = () => {
    const el = viewportRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
  };

  // Fit scale for an image in a viewport — never upscales past 1:1, so small
  // images stay crisp rather than ballooning to fill the pane.
  const fitScaleFor = useCallback(
    (nat: { w: number; h: number }, vp: { w: number; h: number }) => {
      if (nat.w === 0 || nat.h === 0 || vp.w === 0 || vp.h === 0) return 1;
      return Math.min(vp.w / nat.w, vp.h / nat.h, 1);
    },
    [],
  );

  const fit = useCallback(
    (nat = natural) => {
      if (!nat) return;
      const vp = viewportSize();
      const s = fitScaleFor(nat, vp);
      setScale(s);
      setOffset({ x: (vp.w - nat.w * s) / 2, y: (vp.h - nat.h * s) / 2 });
      fittedRef.current = true;
    },
    [natural, fitScaleFor],
  );

  // Zoom to a target scale while keeping the given viewport-local point fixed
  // (defaults to the viewport centre).
  const zoomTo = useCallback((target: number, anchor?: { x: number; y: number }) => {
    const vp = viewportSize();
    const a = anchor ?? { x: vp.w / 2, y: vp.h / 2 };
    setScale((prev) => {
      const next = clampScale(target);
      // #52: keep the anchor (cursor) point fixed under the zoom. Math extracted
      // into the pure, tested `zoomOffset` helper.
      setOffset((o) => zoomOffset(prev, next, o, a));
      return next;
    });
    fittedRef.current = false;
  }, []);

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    const prev = naturalRef.current;
    setNatural(nat);
    if (!prev) {
      // First load: restore the session-persisted zoom/pan (#viewerpos) so an
      // Eldrun restart reopens the image where the reader left it; otherwise fit.
      const init = viewPos.initial;
      if (init?.scale != null) {
        setScale(init.scale);
        setOffset({ x: init.offsetX ?? 0, y: init.offsetY ?? 0 });
        fittedRef.current = false;
        return;
      }
      fit(nat);
      return;
    }
    // Re-fit when the image's dimensions change; on a same-size content update
    // from disk (#68) keep the user's current zoom/pan.
    if (prev.w !== nat.w || prev.h !== nat.h) fit(nat);
  };

  // #viewerpos: persist zoom + pan (throttled, trailing-edge) once an image is
  // up, so reopening it or restarting Eldrun restores this exact view.
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!natural) return;
    const s = scale;
    const ox = offset.x;
    const oy = offset.y;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(
      () => viewPos.persist({ scale: s, offsetX: ox, offsetY: oy }),
      200,
    );
    return () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    };
  }, [scale, offset, natural, viewPos]);

  // Re-fit on viewport resize while still in the fitted baseline state.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Wheel zooms toward the cursor. Bound non-passively (see useNonPassiveWheel)
  // so `preventDefault()` cancels the native scroll instead of the viewport
  // scrolling to its limit before the zoom takes.
  const wheelRef = useNonPassiveWheel((e) => {
    if (!natural) return;
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomTo(scale * factor, anchor);
  });
  // Feed the same node to both the object ref (used for measuring/panning) and
  // the non-passive wheel binding.
  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      wheelRef(el);
    },
    [wheelRef],
  );

  // Pointer-drag panning.
  const dragRef = useRef<{ id: number; startX: number; startY: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!natural || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    setOffset({ x: d.ox + (e.clientX - d.startX), y: d.oy + (e.clientY - d.startY) });
    fittedRef.current = false;
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!natural) return;
    const atFit = Math.abs(scale - fitScaleFor(natural, viewportSize())) < 0.001;
    if (atFit) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
      zoomTo(1, anchor);
    } else {
      fit();
    }
  };

  const percent = Math.round(scale * 100);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <div className="file-viewer-zoom" role="group" aria-label="Zoom controls">
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale / ZOOM_STEP)}
            disabled={!natural || scale <= MIN_SCALE}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="file-viewer-zoom-level" title="Current zoom">{percent}%</span>
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale * ZOOM_STEP)}
            disabled={!natural || scale >= MAX_SCALE}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => fit()}
            disabled={!natural}
            title="Fit to window"
          >
            Fit
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => zoomTo(1)}
            disabled={!natural}
            title="Actual size (100%)"
          >
            1:1
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => setAnnotating(true)}
            disabled={!url}
            title="Annotate / mark up this image"
          >
            ✎ Annotate
          </button>
        </div>
        <PrintButton onPrint={handlePrint} disabled={!url} />
      </ViewerHeader>
      <div className="file-viewer-body file-viewer-image-body">
        {annotating && url != null && (
          <ImageAnnotator
            src={url}
            path={path}
            fileName={fileName}
            onClose={() => setAnnotating(false)}
          />
        )}
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : url == null ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <div
            ref={setViewport}
            className={`file-viewer-image-viewport${dragging ? " dragging" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
          >
            <img
              className="file-viewer-image"
              src={url}
              alt={fileName}
              // #53: a real OS drop source — drag the image into a browser file
              // upload, a chat, etc. We publish the canonical `file://` URI and a
              // DownloadURL so receivers that prefer either get a usable target.
              // NOTE: OS-level drop-out on WebKitGTK is unreliable; this wires the
              // dataTransfer path (unit-testable) and degrades to a no-op where
              // the webview doesn't surface native drags. Tab-drag-out at the OS
              // level likely needs a Tauri capability — see TODO #53 manual test.
              draggable
              onDragStart={(e) => onImageDragStart(e, path)}
              onLoad={onImgLoad}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "0 0",
                visibility: natural ? "visible" : "hidden",
                imageRendering: scale > 2 ? "pixelated" : "auto",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
