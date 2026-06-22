import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useWindowsStore } from "../../stores/windows";
import { findGroupOfTab, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useLinkRoutingStore } from "../../stores/linkRouting";
import { useEditorJumpStore } from "../../stores/editorJump";
import { usePdfSyncStore } from "../../stores/pdfSync";
import { Dropdown } from "../common/Dropdown";
import { renderMarkdown } from "../files/markdown";
import { highlight, languageForPath } from "../files/highlight";
import { internalViewerFor, type InternalViewer, type FileEntry } from "../files/fileUtils";
import {
  type TexCapability,
  type TexCompileResult,
  type SyncRect,
  getTexCapability,
  lastLogLine,
  findTexRefAt,
  resolveTexRefAsync,
  texRefRanges,
  synctexEdit,
  synctexView,
  resolveTexRoot,
  pdfPointToBigPoints,
  bigPointsToCssRect,
  lineStartOffset,
  offsetToLineCol,
} from "../files/tex";

// The modifier that opens a recognised file link (Ctrl/Cmd+Click). Shown verbatim
// in the hover hint, so it must read as the key the user actually presses.
const OPEN_MODIFIER = /Mac|iPhone|iPad/i.test(
  (typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "",
)
  ? "⌘"
  : "Ctrl";
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
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
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
  const name = path.slice(path.lastIndexOf("/") + 1);
  dt.setData("text/uri-list", uri);
  dt.setData("text/plain", uri);
  // DownloadURL = "<mime>:<filename>:<absolute url>". An empty mime lets the OS
  // sniff it; the receiver downloads/copies the file at `uri`.
  dt.setData("DownloadURL", `:${name}:${uri}`);
  dt.effectAllowed = "copy";
}

// pdf.js renders pages on a worker; point it at the bundled worker asset. Vite
// emits a hashed URL that resolves in both dev and the packaged Tauri build.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
export function FileViewerPane({ viewer, path, projectId, tabKey }: Props) {
  const fileName = path.split("/").filter(Boolean).pop() ?? path;

  const openExternally = () => {
    useWindowsStore
      .getState()
      .openFile(path, undefined, projectId, "right_file_tree")
      .catch((e) => console.error(e));
  };

  if (viewer === "image") {
    return <ImageView path={path} fileName={fileName} onOpenExternally={openExternally} />;
  }
  if (viewer === "pdf") {
    return <PdfView path={path} onOpenExternally={openExternally} />;
  }
  if (viewer === "markdown") {
    return <MarkdownView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  }
  if (viewer === "tex") {
    return <TexView path={path} onOpenExternally={openExternally} tabKey={tabKey} />;
  }
  return <TextView path={path} onOpenExternally={openExternally} />;
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
 *  POSIX path, against the directory of the markdown file `mdPath`. Drops any
 *  `?query`/`#fragment` and percent-decoding, and normalises `.`/`..` segments.
 *  Returns null for an empty target. */
function resolveLocalHref(mdPath: string, href: string): string | null {
  let h = href.trim().replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  if (!h) return null;
  try { h = decodeURIComponent(h); } catch { /* keep the raw href */ }
  const dir = mdPath.slice(0, mdPath.lastIndexOf("/"));
  const combined = h.startsWith("/") ? h : `${dir}/${h}`;
  const stack: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return "/" + stack.join("/");
}

/** The built-in viewer for a bare path (no FileEntry handy), used to route a
 *  SyncTeX source target. Defaults to the plain text editor (e.g. `.sty`). */
function viewerForPath(path: string): InternalViewer {
  const name = path.slice(path.lastIndexOf("/") + 1);
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

/**
 * SyncTeX reverse search lands here: open (or re-activate) the source file's
 * editor tab and ask it to scroll to `line`. The editor (`TexView`/`TextView`)
 * for that path consumes the request via the editorJump store, since the tab may
 * already be open and won't remount.
 */
export function jumpToSource(input: string, line: number) {
  const dir = input.slice(0, input.lastIndexOf("/")) || "/";
  const label = input.slice(input.lastIndexOf("/") + 1);
  openLinkedFile(undefined, dir, { path: input, viewer: viewerForPath(input), label });
  useEditorJumpStore.getState().requestJump(input, line);
}

function ViewerHeader({
  onOpenExternally,
  children,
}: {
  onOpenExternally: () => void;
  children?: React.ReactNode;
}) {
  // No filename label: the tab already shows it. The spacer keeps the controls
  // and "Open externally" pushed to the trailing edge as before.
  return (
    <div className="file-viewer-header">
      <div className="file-viewer-header-spacer" aria-hidden="true" />
      {children}
      <button className="file-viewer-open-external" onClick={onOpenExternally} title="Open in external app">
        Open externally ↗
      </button>
    </div>
  );
}

// ── Undo/redo history (#46) ──────────────────────────────────────────────────

/** Edit-history state: a stack of past values, the present value, and a redo
 *  stack of future values. Pure so it can be unit-tested without React. */
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

// Poll interval for the diff-aware auto-reload (#43) and the autosave debounce
// (#47), both ~1.5s.
const RELOAD_POLL_MS = 1500;
const AUTOSAVE_DEBOUNCE_MS = 1500;

/**
 * Editable-file state shared by the code and markdown editors: loads `path`,
 * keeps a `draft` against the last-known-on-disk `baseline` (so "dirty" is just
 * draft !== baseline), and writes the draft back via write_file_text — re-seeding
 * the baseline on success so the dirty flag clears without re-reading the file.
 *
 * Adds (Group M):
 *  - #46 undo/redo: the draft is backed by `useEditHistory`; `undo`/`redo` are
 *    surfaced for keybindings + toolbar buttons.
 *  - #47 autosave: when `settings.autosave` is on, a dirty buffer is saved after
 *    a debounce.
 *  - #43 diff-aware reload: polls `file_mtime`; when the file changes on disk it
 *    silently re-reads into a clean buffer, or surfaces a non-destructive banner
 *    when the buffer is dirty (Reload / Keep mine) — never clobbering edits.
 */
function useEditableFile(path: string) {
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

  const autosave = useSettingsStore((s) => s.settings?.autosave ?? false);

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
    invoke<string>("read_file_text", { path })
      .then((text) => {
        if (cancelled) return;
        seedFromDisk(text);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    invoke<number>("file_mtime", { path })
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, seedFromDisk]);

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
      await invoke("write_file_text", { path, content: toSave });
      setBaseline(toSave);
      setExternalChange(false);
      // Our own write advances mtime; refresh so the poller doesn't see it as an
      // external change.
      try {
        lastMtime.current = await invoke<number>("file_mtime", { path });
      } catch {
        /* mtime refresh is best-effort */
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [saving, path]);

  // #47 autosave: debounce-save a dirty buffer when the setting is on.
  useEffect(() => {
    if (!autosave || !isDirty) return;
    const id = setTimeout(() => { void save(); }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [autosave, isDirty, draft, save]);

  // #43 diff-aware reload: poll mtime; on an external advance, re-read into a
  // clean buffer silently, or flag a banner if the buffer is dirty.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const id = setInterval(() => {
      invoke<number>("file_mtime", { path })
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
          invoke<string>("read_file_text", { path })
            .then((text) => { if (!cancelled) seedFromDisk(text); })
            .catch(() => {});
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path, loaded, seedFromDisk]);

  // Banner actions (#43): take the disk version, or keep mine (dismiss banner +
  // adopt current mtime so the next external change re-triggers).
  const reloadFromDisk = useCallback(() => {
    invoke<string>("read_file_text", { path })
      .then((text) => seedFromDisk(text))
      .catch((e) => setSaveError(String(e)));
  }, [path, seedFromDisk]);
  const keepMine = useCallback(() => setExternalChange(false), []);

  return {
    content, error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo,
    externalChange, reloadFromDisk, keepMine,
  };
}

/** The non-destructive external-change banner (#43). */
function ExternalChangeBanner({
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
function applyIndent(
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
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
function snapToDevicePx(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr) / dpr;
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
  fontSize,
  lineHeight,
  incFont,
  decFont,
  resetFont,
  wrap,
  gotoLine,
  onGotoApplied,
  onCaretChange,
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
  /** SyncTeX reverse-search target: move the caret to (1-based) `line` and
   *  scroll it into view whenever `nonce` changes. */
  gotoLine?: { line: number; nonce: number };
  /** Called once a `gotoLine` request has been applied, so the caller can clear
   *  it (consume the editorJump request). */
  onGotoApplied?: () => void;
  /** Reports the current caret offset (after clicks / key navigation), so the
   *  LaTeX viewer can run SyncTeX forward search from it on compile. */
  onCaretChange?: (offset: number) => void;
  /** When set, returns the source ranges to decorate as clickable file links
   *  (#49). Currently the LaTeX viewer's `\input{…}`/`\includegraphics{…}` args. */
  linkRanges?: (source: string) => { start: number; end: number }[];
  /** Undo/redo handlers (#46) — wired to Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
  undo?: () => void;
  redo?: () => void;
  /** Opt-in local autocomplete config (#45). Disabled when undefined/off. */
  autocomplete?: { enabled: boolean; model: string };
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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const linkLayerRef = useRef<HTMLPreElement>(null);
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
  const acAbort = useRef<AbortController | null>(null);

  // Snap the line-height to whole device pixels so the textarea caret and the
  // highlight <pre> share a vertical grid and don't drift apart over a long file
  // under fractional display scaling (see snapToDevicePx).
  const dpr = useDevicePixelRatio();

  const lineCount = useMemo(
    () => (loaded ? Math.max(1, draft.split("\n").length) : 1),
    [loaded, draft],
  );

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
    const transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    for (const ref of [highlightRef, linkLayerRef]) {
      if (ref.current) ref.current.style.transform = transform;
    }
  }, []);
  const onScroll = () => syncScroll();

  // Re-sync the overlay layers whenever the editor is resized (window resize,
  // pane/divider drag, panel toggle). A resize can clamp the textarea's
  // scrollLeft/scrollTop without emitting a scroll event, which otherwise leaves
  // the coloured glyphs — and so the visible caret — shifted from the text. A
  // ResizeObserver on the textarea catches every cause (it is full-width, so a
  // window resize changes its box too). Guarded for jsdom, where it's absent.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScroll());
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll, loaded]);

  // Report the caret position so the LaTeX viewer can run SyncTeX forward search
  // from it. Cheap; only wired when `onCaretChange` is supplied.
  const emitCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el && onCaretChange) onCaretChange(el.selectionStart);
  }, [onCaretChange]);

  // SyncTeX reverse search: on a new `gotoLine` nonce, place the caret at the
  // start of the target line and scroll it to roughly the middle of the view.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!gotoLine || !loaded) return;
    const el = textareaRef.current;
    if (!el) return;
    const offset = lineStartOffset(draftRef.current, gotoLine.line);
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
  }, []);

  // #45: request a completion at the caret. Privacy-gated by the caller (only
  // wired when the per-type setting is on); also ensures Ollama is up first and
  // fails silently otherwise.
  const requestCompletion = useCallback(async () => {
    const el = textareaRef.current;
    if (!el || !autocomplete?.enabled || !autocomplete.model) return;
    const caret = el.selectionStart;
    const prefix = draft.slice(0, caret);
    const suffix = draft.slice(caret);
    acAbort.current?.abort();
    const ctl = new AbortController();
    acAbort.current = ctl;
    try {
      await invoke("ensure_ollama_running");
      if (ctl.signal.aborted) return;
      const text = await invoke<string>("complete_text", {
        prefix,
        suffix,
        model: autocomplete.model,
        language: lang === "plain" ? "" : lang,
      });
      if (ctl.signal.aborted) return;
      if (text) setSuggestion({ text, at: caret });
    } catch {
      // Ollama not running / errored → fail silently (no remote fallback).
    }
  }, [autocomplete, draft, lang]);

  const acceptSuggestion = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !suggestion) return;
    const at = suggestion.at;
    const next = draft.slice(0, at) + suggestion.text + draft.slice(at);
    setDraft(next);
    const caret = at + suggestion.text.length;
    setSuggestion(null);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  }, [suggestion, draft, setDraft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onFollowLink && (e.ctrlKey || e.metaKey) && lastMouse.current) {
      updateLinkHover(lastMouse.current.x, lastMouse.current.y, true);
    }

    // #45: Ctrl+Space requests a suggestion; Tab accepts; Esc dismisses.
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      void requestCompletion();
      return;
    }
    if (suggestion) {
      if (e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion();
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
      setDraft(next.value);
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
  };

  if (error != null) return <div className="file-viewer-error">{error}</div>;
  if (!loaded) return <div className="file-viewer-loading">Loading…</div>;

  // Ghost text: render the draft up to the caret (transparent) then the
  // suggestion (dimmed) so it sits inline where it would be inserted.
  const ghost =
    suggestion != null
      ? draft.slice(0, suggestion.at) + suggestion.text
      : null;

  return (
    <div
      className="file-viewer-code"
      onWheel={(e) => onCtrlWheelFont(e, incFont, decFont)}
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
      {/* The gutter renders one fixed-height row per logical line; that can only
          stay aligned when lines don't wrap, so it's omitted in wrap mode (the
          LaTeX viewer), where a wrapped line spans several visual rows. */}
      {!wrap && (
        <div className="file-viewer-gutter" aria-hidden="true">
          <div className="file-viewer-gutter-inner" ref={gutterInnerRef}>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i} className="file-viewer-gutter-line">{i + 1}</div>
            ))}
          </div>
        </div>
      )}
      <div
        className={`file-viewer-code-area${highlighted != null ? " highlighted" : ""}${
          linkHover ? " link-hover" : ""
        }${wrap ? " is-wrapped" : ""}`}
      >
        {highlighted != null && (
          <pre
            ref={highlightRef}
            className="file-viewer-highlight"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlighted + "\n" }}
          />
        )}
        {linkHtml != null && (
          <pre
            ref={linkLayerRef}
            className="file-viewer-link-layer"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: linkHtml + "\n" }}
          />
        )}
        {ghost != null && (
          <pre className="file-viewer-ghost" aria-hidden="true">
            <span className="file-viewer-ghost-hidden">{draft.slice(0, suggestion!.at)}</span>
            <span className="file-viewer-ghost-text">{suggestion!.text}</span>
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className="file-viewer-editor file-viewer-code-editor"
          value={draft}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (!(e.ctrlKey || e.metaKey)) setLinkHover(false); emitCaret(); }}
          onBlur={() => { setLinkHover(false); setLinkTip(null); dismissSuggestion(); }}
          onMouseMove={onMouseMove}
          onMouseLeave={() => { setLinkHover(false); setLinkTip(null); }}
          onClick={onClick}
          onSelect={emitCaret}
          onScroll={onScroll}
        />
      </div>
      {onFollowLink && <LinkOpenHint at={linkTip} />}
    </div>
  );
}

/**
 * Save control shared by the editable viewers (#47). Shows a state ICON rather
 * than text: a spinner while saving, a filled disk with a dot when there are
 * unsaved edits, and a check when clean. `aria-label="Save"` keeps it findable.
 */
function SaveButton({
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

/** Undo/redo toolbar buttons shared by the editable viewers (#46). */
function UndoRedoButtons({
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

/** Resolve the per-type viewer prefs for an InternalViewer from settings (#48). */
function useViewerPref(type: InternalViewer) {
  return useSettingsStore((s) => s.settings?.viewer_prefs?.[type]);
}

/** The model used for local autocomplete (#45). Reuses the global agent command
 *  when it is an Ollama model name; falls back to a small coder model. We don't
 *  add a separate setting — the per-type `autocomplete` toggle is the gate. */
function useAutocompleteConfig(type: InternalViewer): { enabled: boolean; model: string } {
  const pref = useViewerPref(type);
  const model = useSettingsStore(
    (s) => (s.settings?.autocomplete_model as string | undefined) ?? "qwen2.5-coder:1.5b",
  );
  return { enabled: pref?.autocomplete === true, model };
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
 *  native scrolling. */
function onCtrlWheelFont(
  e: React.WheelEvent,
  inc?: () => void,
  dec?: () => void,
) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.deltaY < 0) inc?.();
  else if (e.deltaY > 0) dec?.();
}

/**
 * Per-type editor font size (text-size +/− control). Reads the persisted
 * `viewer_prefs[type].font_size`, clamps it, and exposes inc/dec/reset that write
 * the new size back through `updateSettings` — merging the whole viewer_prefs map
 * the same way the settings panel does, so it round-trips to settings.json.
 */
function useEditorFontSize(type: InternalViewer) {
  const pref = useViewerPref(type);
  const fontSize = clampFontSize(pref?.font_size ?? EDITOR_FONT_DEFAULT);

  const setFontSize = useCallback(
    (next: number) => {
      const size = clampFontSize(next);
      const all = useSettingsStore.getState().settings?.viewer_prefs ?? {};
      const cur = all[type] ?? {};
      if (cur.font_size === size) return;
      void useSettingsStore.getState().updateSettings({
        viewer_prefs: { ...all, [type]: { ...cur, font_size: size } },
      });
    },
    [type],
  );

  return {
    fontSize,
    lineHeight: Math.round(fontSize * EDITOR_LINE_RATIO),
    // True once the user has set a size — lets surfaces with their own default
    // (the markdown preview) leave it alone until then.
    isCustom: pref?.font_size != null,
    inc: useCallback(() => setFontSize(fontSize + 1), [setFontSize, fontSize]),
    dec: useCallback(() => setFontSize(fontSize - 1), [setFontSize, fontSize]),
    reset: useCallback(() => setFontSize(EDITOR_FONT_DEFAULT), [setFontSize]),
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
  return {
    gotoLine: req ? { line: req.line, nonce: req.nonce } : undefined,
    onGotoApplied,
  };
}

function TextView({
  path,
  onOpenExternally,
}: {
  path: string;
  onOpenExternally: () => void;
}) {
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const ac = useAutocompleteConfig("text");
  const font = useEditorFontSize("text");
  const jump = useEditorJump(path);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      <div className="file-viewer-body file-viewer-code-body">
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
          fontSize={font.fontSize}
          lineHeight={font.lineHeight}
          incFont={font.inc}
          decFont={font.dec}
          resetFont={font.reset}
          gotoLine={jump.gotoLine}
          onGotoApplied={jump.onGotoApplied}
        />
      </div>
    </div>
  );
}

function MarkdownView({
  path,
  onOpenExternally,
  tabKey,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const font = useEditorFontSize("markdown");
  // Preview always reflects the live draft, so toggling shows unsaved edits.
  const html = useMemo(() => (loaded ? renderMarkdown(draft) : ""), [loaded, draft]);

  // #49/#50: local-file links in the rendered preview open in-app on
  // Ctrl/Cmd+Click (matching the LaTeX editor). A hover hint advertises the
  // shortcut. `linkTip` anchors that hint above the hovered link.
  const [linkTip, setLinkTip] = useState<{ left: number; top: number } | null>(null);

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
      openLinkedFile(tabKey, path.slice(0, path.lastIndexOf("/")), {
        path: target,
        viewer: viewerForPath(target),
        label: target.slice(target.lastIndexOf("/") + 1),
      });
    },
    [path, tabKey],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    // #46 undo/redo for the plain markdown editor textarea.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    // Text size: Ctrl/Cmd with "+"/"=" grows, "-" shrinks, "0" resets.
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        font.inc();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        font.dec();
      } else if (e.key === "0") {
        e.preventDefault();
        font.reset();
      }
    }
  };

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
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {mode === "edit" && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      <div
        className="file-viewer-body"
        onWheel={(e) => onCtrlWheelFont(e, font.inc, font.dec)}
      >
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : mode === "edit" ? (
          <textarea
            className="file-viewer-editor"
            value={draft}
            spellCheck={false}
            style={{ fontSize: `${font.fontSize}px`, lineHeight: `${font.lineHeight}px` }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div
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

/** Load a file's bytes once and expose them as a Blob object URL (revoked on
 *  unmount / path change), used by the image viewer (<img> sniffs the type). */
function useBlobUrl(path: string, type: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setUrl(null);
    invoke<number[]>("read_file_bytes", { path })
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], type ? { type } : undefined);
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [path, type]);

  return { url, error };
}

const PDF_MIN_SCALE = 0.1;
const PDF_MAX_SCALE = 8;
const PDF_ZOOM_STEP = 1.2;
const clampPdfScale = (s: number) => Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, s));

/** One PDF page rendered to a canvas at `scale` (× devicePixelRatio for
 *  crispness). Re-renders when the page or scale changes; cancels an in-flight
 *  render on cleanup so rapid zooming doesn't paint stale frames. */
function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  onSyncClick,
  highlight,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** SyncTeX reverse search: a click maps to big points on this page. */
  onSyncClick?: (page: number, xBp: number, yBp: number) => void;
  /** SyncTeX forward search: when this page is the target, the box (big points)
   *  to scroll into view and flash. `nonce` re-triggers a repeat reveal. */
  highlight?: { rect: SyncRect; nonce: number } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      task = page.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* render cancelled by a newer scale — ignore */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale]);

  // Scroll a forward-search target page into view on a new nonce.
  useEffect(() => {
    if (highlight) wrapRef.current?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSyncClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const { x, y } = pdfPointToBigPoints(rect, e.clientX, e.clientY, scale);
    onSyncClick(pageNumber, x, y);
  };

  const box = highlight ? bigPointsToCssRect(highlight.rect, scale) : null;

  return (
    <div className="file-viewer-pdf-page-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`file-viewer-pdf-page${onSyncClick ? " is-syncable" : ""}`}
        onClick={onClick}
      />
      {box && (
        <div
          key={highlight!.nonce}
          className="file-viewer-pdf-sync-highlight"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}

/**
 * Reusable pdf.js-backed PDF view: a zoom toolbar over a scrolling stack of page
 * canvases. Unlike the old native `<iframe>`, every surface here is ours, so the
 * surround and (via the global scrollbar rules) the scrollbar follow the app
 * theme — giving a dark viewer in dark themes while the pages stay as authored.
 *
 * The bytes at `path` can change under us — e.g. the LaTeX viewer recompiles the
 * PDF this tab is showing — so we poll `file_mtime` and reload when it advances,
 * the PDF counterpart to the editors' diff-aware reload (#43).
 */
function PdfCanvas({
  path,
  onOpenExternally,
}: {
  path: string;
  /** When set, an "Open externally" button is shown at the end of the toolbar.
   *  Used by the standalone PDF tab, which has no separate header row. */
  onOpenExternally?: () => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // After a Ctrl+wheel zoom changes `scale`, the page canvases re-render to the
  // new size asynchronously. We stash the scroll target that keeps the cursor's
  // document point fixed and apply it once the content has actually resized.
  const pendingScroll = useRef<{ top: number; left: number } | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);
  const lastMtime = useRef<number | null>(null);
  // True when a `.synctex(.gz)` sits beside the PDF, enabling reverse search.
  const [syncable, setSyncable] = useState(false);

  // SyncTeX forward search: a pending reveal/highlight request for this PDF.
  // Copied into local state so we can consume the store request immediately
  // (avoiding a re-fire) while keeping the highlight mounted to animate.
  const reveal = usePdfSyncStore((s) => s.byPath[path] ?? null);
  const consumeReveal = usePdfSyncStore((s) => s.consume);
  const [highlight, setHighlight] = useState<{ rect: SyncRect; nonce: number } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    setHighlight({ rect: reveal.rect, nonce: reveal.nonce });
    consumeReveal(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);

  // Probe for SyncTeX data beside the PDF; re-checked after each disk change
  // (a recompile may have just written it).
  useEffect(() => {
    let cancelled = false;
    const base = path.replace(/\.pdf$/i, "");
    const exists = (p: string) =>
      invoke<number>("file_mtime", { path: p }).then(() => true).catch(() => false);
    void Promise.all([exists(`${base}.synctex.gz`), exists(`${base}.synctex`)]).then(
      ([gz, raw]) => { if (!cancelled) setSyncable(gz || raw); },
    );
    return () => { cancelled = true; };
  }, [path, diskVersion]);

  // Reverse search: a click on a page → which source line produced it → jump.
  const onSyncClick = useCallback(
    async (page: number, x: number, y: number) => {
      const src = await synctexEdit(path, page, x, y);
      if (src) jumpToSource(src.input, src.line);
    },
    [path],
  );

  // Poll mtime; on an advance (e.g. a recompile wrote a new PDF), bump
  // diskVersion so the load effect re-reads the fresh bytes (#43-style).
  useEffect(() => {
    lastMtime.current = null;
    let cancelled = false;
    invoke<number>("file_mtime", { path })
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    const id = setInterval(() => {
      invoke<number>("file_mtime", { path })
        .then((m) => {
          if (cancelled || lastMtime.current == null || m <= lastMtime.current) return;
          lastMtime.current = m;
          setDiskVersion((v) => v + 1);
        })
        .catch(() => {});
    }, RELOAD_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [path]);

  // Load (and reload on path / disk change) the document. pdf.js detaches the
  // backing buffer, so each load gets a fresh Uint8Array; the prior document is
  // destroyed on cleanup to free worker memory.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    (async () => {
      try {
        const bytes = await invoke<number[]>("read_file_bytes", { path });
        if (cancelled) return;
        loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
        if (cancelled) {
          loaded.destroy();
          loaded = null;
          return;
        }
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [path, diskVersion]);

  // Fit the first page to the viewport width when a document loads.
  const fitWidth = useCallback(async (d: PDFDocumentProxy) => {
    const el = scrollRef.current;
    if (!el) return;
    const page = await d.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const avail = el.clientWidth - 24; // leave room for page margins
    if (avail > 0 && vp.width > 0) setScale(clampPdfScale(avail / vp.width));
  }, []);

  useEffect(() => {
    if (doc) void fitWidth(doc);
  }, [doc, fitWidth]);

  // Ctrl/Cmd+wheel zooms the page stack toward the cursor (a plain wheel keeps
  // native scrolling). Because the canvases resize asynchronously, we only
  // compute the cursor-anchored scroll target here and let the ResizeObserver
  // below apply it once the content has grown/shrunk.
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    setScale((prev) => {
      const factor = e.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
      const next = clampPdfScale(prev * factor);
      if (next === prev) return prev;
      const eff = next / prev;
      pendingScroll.current = {
        top: (el.scrollTop + cursorY) * eff - cursorY,
        left: (el.scrollLeft + cursorX) * eff - cursorX,
      };
      return next;
    });
  }, []);

  // Apply a pending cursor-anchored scroll target once the page content has
  // resized after a zoom (the observer fires when the canvases repaint).
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const target = pendingScroll.current;
      if (!target) return;
      pendingScroll.current = null;
      el.scrollTop = target.top;
      el.scrollLeft = target.left;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [doc]);

  return (
    <div className="file-viewer-pdf-host">
      <div className="file-viewer-pdf-toolbar" role="group" aria-label="PDF zoom controls">
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setScale((s) => clampPdfScale(s / PDF_ZOOM_STEP))}
          disabled={!doc || scale <= PDF_MIN_SCALE}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="file-viewer-zoom-level">{Math.round(scale * 100)}%</span>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setScale((s) => clampPdfScale(s * PDF_ZOOM_STEP))}
          disabled={!doc || scale >= PDF_MAX_SCALE}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="file-viewer-zoom-btn file-viewer-zoom-text"
          onClick={() => doc && void fitWidth(doc)}
          disabled={!doc}
          title="Fit page width"
        >
          Fit width
        </button>
        {onOpenExternally && (
          <button
            className="file-viewer-open-external file-viewer-pdf-external"
            onClick={onOpenExternally}
            title="Open in external app"
          >
            Open externally ↗
          </button>
        )}
      </div>
      <div className="file-viewer-pdf-scroll" ref={scrollRef} onWheel={onWheel}>
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !doc ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <div className="file-viewer-pdf-pages" ref={contentRef}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPageCanvas
                key={i}
                doc={doc}
                pageNumber={i + 1}
                scale={scale}
                onSyncClick={syncable ? onSyncClick : undefined}
                highlight={highlight && highlight.rect.page === i + 1 ? highlight : null}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfView({
  path,
  onOpenExternally,
}: {
  path: string;
  onOpenExternally: () => void;
}) {
  // No ViewerHeader: the tab already shows the file name, so a filename row would
  // be redundant. The "Open externally" action lives in the PdfCanvas toolbar.
  return (
    <div className="file-viewer">
      <div className="file-viewer-body">
        <PdfCanvas path={path} onOpenExternally={onOpenExternally} />
      </div>
    </div>
  );
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
  const ac = useAutocompleteConfig("tex");
  const font = useEditorFontSize("tex");

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
    async (caret: number) => {
      const target = findTexRefAt(draft, caret);
      if (!target) return;
      const resolved = await resolveTexRefAsync(path, target);
      if (!resolved) return;
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      openLinkedFile(tabKey, dir, resolved);
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
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  // 0 = never compiled (preview shows a placeholder); each successful compile
  // bumps this to force the PDF blob to refetch the freshly written bytes.
  const [pdfVersion, setPdfVersion] = useState(0);

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
  const rootName = root.slice(root.lastIndexOf("/") + 1);

  // Open the compiled PDF as its own tab (it is a real file), reusing the embed
  // viewer. openLinkedFile dedupes against an already-open PDF tab for the same
  // path and routes to the same subwindow as this tab; the PDF pane polls mtime,
  // so a reused tab reloads the freshly compiled bytes on its own.
  const openPdf = useCallback(
    (pdf: string) => {
      const name = pdf.slice(pdf.lastIndexOf("/") + 1);
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      openLinkedFile(tabKey, dir, { path: pdf, viewer: "pdf", label: name });
    },
    [path, tabKey],
  );

  const compile = useCallback(async () => {
    if (compiling) return;
    setCompiling(true);
    setCompileError(null);
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
        const detail = lastLogLine(res.log);
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
        const { line, column } = offsetToLineCol(draftRef.current, caretRef.current);
        const rect = await synctexView(res.pdf_path, path, line, column);
        if (rect) usePdfSyncStore.getState().requestReveal(res.pdf_path, rect);
      }
    } catch (e) {
      setCompileError(String(e));
    } finally {
      setCompiling(false);
    }
  }, [compiling, save, path, engine, outDir, extraFlags, openPdf]);

  // No engine (or still probing): degrade to exactly the plain-text editor.
  if (!cap || !cap.available) {
    return (
      <div className="file-viewer">
        <ViewerHeader onOpenExternally={onOpenExternally}>
          <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
          <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        </ViewerHeader>
        {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
        {saveError && <div className="file-viewer-error">{saveError}</div>}
        <div className="file-viewer-body file-viewer-code-body">
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            onFollowLink={followLink}
            linkRanges={linkRanges}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            gotoLine={jump.gotoLine}
            onGotoApplied={jump.onGotoApplied}
            onCaretChange={onCaret}
            wrap
          />
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
        <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
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
        <CodeEditor
          path={path}
          error={error}
          draft={draft}
          setDraft={setDraft}
          loaded={loaded}
          save={() => void save()}
          onFollowLink={followLink}
          linkRanges={linkRanges}
          undo={undo}
          redo={redo}
          autocomplete={ac}
          fontSize={font.fontSize}
          lineHeight={font.lineHeight}
          incFont={font.inc}
          decFont={font.dec}
          resetFont={font.reset}
          gotoLine={jump.gotoLine}
          onGotoApplied={jump.onGotoApplied}
          onCaretChange={onCaret}
          wrap
        />
      </div>
    </div>
  );
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;
const ZOOM_STEP = 1.2;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

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
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
}) {
  const { url, error } = useBlobUrl(path, "");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Natural (intrinsic) image size in pixels, set on load.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
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
    setNatural(nat);
    fit(nat);
  };

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

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!natural) return;
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomTo(scale * factor, anchor);
  };

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
        </div>
      </ViewerHeader>
      <div className="file-viewer-body file-viewer-image-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : url == null ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <div
            ref={viewportRef}
            className={`file-viewer-image-viewport${dragging ? " dragging" : ""}`}
            onWheel={onWheel}
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
