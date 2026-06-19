import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWindowsStore } from "../../stores/windows";
import { renderMarkdown } from "../files/markdown";
import type { InternalViewer } from "../files/fileUtils";

interface Props {
  /** Which built-in viewer to render with. */
  viewer: InternalViewer;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Owning project id (null in the root scope). */
  projectId: string | null;
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
 *   - "pdf"      → the bytes wrapped in a Blob URL, shown in an <iframe> (the
 *                  WebKitGTK runtime renders PDFs natively).
 * An "Open externally" button is always offered as a fallback.
 */
export function FileViewerPane({ viewer, path, projectId }: Props) {
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
    return <PdfView path={path} fileName={fileName} onOpenExternally={openExternally} />;
  }
  if (viewer === "markdown") {
    return <MarkdownView path={path} fileName={fileName} onOpenExternally={openExternally} />;
  }
  return <TextView path={path} fileName={fileName} onOpenExternally={openExternally} />;
}

function ViewerHeader({
  fileName,
  onOpenExternally,
  children,
}: {
  fileName: string;
  onOpenExternally: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="file-viewer-header">
      <span className="file-viewer-name" title={fileName}>{fileName}</span>
      {children}
      <button className="file-viewer-open-external" onClick={onOpenExternally} title="Open in external app">
        Open externally ↗
      </button>
    </div>
  );
}

/** Read a file's UTF-8 contents once, tracking load state. */
function useTextContent(path: string) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    invoke<string>("read_file_text", { path })
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path]);
  return { content, error };
}

/**
 * Editable-file state shared by the code and markdown editors: loads `path`,
 * keeps a `draft` against the last-known-on-disk `baseline` (so "dirty" is just
 * draft !== baseline), and writes the draft back via write_file_text — re-seeding
 * the baseline on success so the dirty flag clears without re-reading the file.
 */
function useEditableFile(path: string) {
  const { content, error } = useTextContent(path);
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loaded = content != null;
  useEffect(() => {
    if (content != null) {
      setDraft(content);
      setBaseline(content);
    }
  }, [content]);

  const isDirty = loaded && baseline != null && draft !== baseline;

  const save = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await invoke("write_file_text", { path, content: draft });
      setBaseline(draft);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, path, draft]);

  return { content, error, draft, setDraft, loaded, isDirty, saving, saveError, save };
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
 * In-tab code editor for plain-text/source files. A monospace textarea with a
 * scroll-synced line-number gutter, Tab/Shift+Tab indentation, and Ctrl/Cmd+S
 * (or the Save button) to write the file back to disk.
 */
function TextView({
  path,
  fileName,
  onOpenExternally,
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
}) {
  const { error, draft, setDraft, loaded, isDirty, saving, saveError, save } =
    useEditableFile(path);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = useMemo(
    () => (loaded ? Math.max(1, draft.split("\n").length) : 1),
    [loaded, draft],
  );

  // Keep the gutter aligned with the textarea as it scrolls.
  const onScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
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

  return (
    <div className="file-viewer">
      <ViewerHeader fileName={fileName} onOpenExternally={onOpenExternally}>
        <button
          className="file-viewer-save"
          onClick={() => void save()}
          disabled={!isDirty || saving}
          title={isDirty ? "Save (Ctrl+S)" : "No unsaved changes"}
        >
          {saving ? "Saving…" : isDirty ? "Save •" : "Saved"}
        </button>
      </ViewerHeader>
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      <div className="file-viewer-body file-viewer-code-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <div className="file-viewer-code">
            <div className="file-viewer-gutter" ref={gutterRef} aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="file-viewer-gutter-line">{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="file-viewer-editor file-viewer-code-editor"
              value={draft}
              spellCheck={false}
              wrap="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={onScroll}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownView({
  path,
  fileName,
  onOpenExternally,
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
}) {
  const { error, draft, setDraft, loaded, isDirty, saving, saveError, save } =
    useEditableFile(path);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  // Preview always reflects the live draft, so toggling shows unsaved edits.
  const html = useMemo(() => (loaded ? renderMarkdown(draft) : ""), [loaded, draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="file-viewer">
      <ViewerHeader fileName={fileName} onOpenExternally={onOpenExternally}>
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
        <button
          className="file-viewer-save"
          onClick={() => void save()}
          disabled={!isDirty || saving}
          title={isDirty ? "Save (Ctrl+S)" : "No unsaved changes"}
        >
          {saving ? "Saving…" : isDirty ? "Save •" : "Saved"}
        </button>
      </ViewerHeader>
      {saveError && <div className="file-viewer-error">{saveError}</div>}
      <div className="file-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : mode === "edit" ? (
          <textarea
            className="file-viewer-editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}

/** Load a file's bytes once and expose them as a Blob object URL (revoked on
 *  unmount / path change). `type` matters for the PDF <iframe>; <img> sniffs. */
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

function PdfView({
  path,
  fileName,
  onOpenExternally,
}: {
  path: string;
  fileName: string;
  onOpenExternally: () => void;
}) {
  const { url, error } = useBlobUrl(path, "application/pdf");
  return (
    <div className="file-viewer">
      <ViewerHeader fileName={fileName} onOpenExternally={onOpenExternally} />
      <div className="file-viewer-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : url == null ? (
          <div className="file-viewer-loading">Loading…</div>
        ) : (
          <iframe className="file-viewer-pdf" src={url} title={fileName} />
        )}
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
      setOffset((o) => ({
        x: a.x - ((a.x - o.x) * next) / prev,
        y: a.y - ((a.y - o.y) * next) / prev,
      }));
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
      <ViewerHeader fileName={fileName} onOpenExternally={onOpenExternally}>
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
              draggable={false}
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
