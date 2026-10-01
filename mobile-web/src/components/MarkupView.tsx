import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ApiError, MAX_INBOX_FILE, sentName, submitMarkup, uploadToInbox, viewerFileUrl, type MarkupSource, type OutboxFile, type ViewerScope } from "../api";
import { acceptFrameMessage, MAX_FRAME_PAGES, MAX_RENDER_WIDTH, type FrameFailure } from "../markup/frameProtocol";
import {
  addMark, canAdd, canReplace, clampToPage, clearPage, commit, eraseAt, finishStroke, inkWidth, isEmpty, MARK_COLORS, markedPages, redo, replaceMark,
  round, startHistory, textBox, undo, type BoxMark, type History, type InkMark, type Layer, type Mark, type MarkColor, type PageLayer, type TextMark,
} from "../markup/layer";
import { composedPng, drawMark, drawPage, INK, layerPng } from "../markup/rasterize";
import { clearLayer, layerKey, loadLayer, saveLayer, stale, type Fingerprint } from "../markup/store";
import { storageDashKey } from "../../../src/lib/brand";

type Tool = "ink" | "box" | "text" | "eraser";
type Size = [number, number];
type Picture = { bitmap: ImageBitmap; width: number };
type Failure = FrameFailure | "tooLarge" | "fetch" | "timeout" | "picture";

/** Room between pages, CSS pixels. */
const GAP = 12;
/** How far the view zooms in. */
const MAX_ZOOM = 4;
/** Page pictures kept alive at once — Safari's canvas memory is the limit. */
const MAX_ALIVE = 6;
/** How long the frame may take to open a document before it is given up,
 * and to draw one page before that page is. */
const OPEN_TIMEOUT = 45_000;
const RENDER_TIMEOUT = 20_000;
/** Remembered once a pen has drawn here: from then on fingers only scroll. */
const PEN_KEY = storageDashKey("markup-pen");

const FAILURE_KEYS: Record<Failure, TranslationKey> = {
  unreadable: "mobile.markup.failed.unreadable",
  encrypted: "mobile.markup.failed.encrypted",
  render: "mobile.markup.failed.unreadable",
  unsupported: "mobile.markup.failed.unreadable",
  tooLarge: "mobile.markup.failed.tooLarge",
  fetch: "mobile.markup.failed.fetch",
  timeout: "mobile.markup.failed.timeout",
  picture: "mobile.markup.failed.picture",
};

/** Why a step of Submit failed, in the reader's words. */
const REASON_KEYS: Record<string, TranslationKey> = {
  file_too_large: "mobile.markup.reason.tooLarge",
  inbox_full: "mobile.markup.reason.inboxFull",
  offline: "mobile.markup.reason.offline",
  timeout: "mobile.markup.reason.timeout",
  files_off: "mobile.markup.reason.filesOff",
  file_not_found: "mobile.markup.reason.gone",
  tab_not_found: "mobile.markup.reason.gone",
  project_unavailable: "mobile.markup.reason.project",
};

function readPenSeen(): boolean {
  try { return localStorage.getItem(PEN_KEY) === "1"; } catch { return false; }
}
function rememberPen(): void {
  try { localStorage.setItem(PEN_KEY, "1"); } catch { /* a convenience only */ }
}

/** The file name without its extension — what the inbox copies are called after. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** One page's place in the scroller: its top and height, CSS pixels. */
function layout(sizes: Size[], width: number): { top: number; height: number }[] {
  let top = 0;
  return sizes.map(([w, h]) => {
    const height = width * h / w;
    const place = { top, height };
    top += height + GAP;
    return place;
  });
}

/** The picture of one PDF page, painted from the frame's bitmap. */
function PagePicture({ picture }: { picture: Picture | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // A dropped picture gives its backing store back at once — Safari counts
    // canvas memory against the whole page.
    element.width = picture?.bitmap.width ?? 0;
    element.height = picture?.bitmap.height ?? 0;
    if (picture) element.getContext("2d")?.drawImage(picture.bitmap, 0, 0);
  }, [picture]);
  useEffect(() => () => {
    const element = canvas.current;
    if (element) { element.width = 0; element.height = 0; }
  }, []);
  return <canvas ref={canvas} className="markup-page-picture" aria-hidden="true" />;
}

/** The marks of one page, drawn over its picture. */
function LayerCanvas({ size, page, preview, pixelWidth, register, n, handlers }: {
  size: Size;
  page: PageLayer | undefined;
  /** A box being dragged out, drawn on top until it is let go. */
  preview: Mark | null;
  pixelWidth: number;
  register: (n: number, canvas: HTMLCanvasElement | null) => void;
  n: number;
  handlers: {
    onPointerDown: (n: number, event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  };
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => () => {
    const element = canvas.current;
    if (element) { element.width = 0; element.height = 0; }
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = pixelWidth;
    element.height = Math.max(1, Math.round(pixelWidth * size[1] / size[0]));
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    const scale = pixelWidth / size[0];
    if (page) drawPage(ctx, page, scale);
    if (preview) {
      ctx.save();
      ctx.scale(scale, scale);
      drawMark(ctx, preview);
      ctx.restore();
    }
  }, [page, preview, pixelWidth, size]);
  return <canvas
    ref={(element) => { canvas.current = element; register(n, element); }}
    className="markup-page-layer"
    onPointerDown={(event) => handlers.onPointerDown(n, event)}
    onPointerMove={handlers.onPointerMove}
    onPointerUp={handlers.onPointerUp}
    onPointerCancel={handlers.onPointerUp}
  />;
}

/** What a pointer is doing on a page between down and up. */
type Gesture =
  | { kind: "ink"; n: number; pointerId: number; mark: InkMark; last: [number, number] }
  | { kind: "box"; n: number; pointerId: number; start: [number, number]; end: [number, number] }
  | { kind: "erase"; n: number; pointerId: number }
  | { kind: "text"; n: number; pointerId: number; start: [number, number]; clientX: number; clientY: number };

/** A note being typed: where it goes, and which existing note it replaces. */
type NoteDraft = { n: number; at: [number, number]; index: number | null; text: string; color: MarkColor; size: number };

/**
 * **Mark up** — a PDF's pages or a picture with a layer to write on that
 * lives only on this phone (`docs/mobile_pdf_markup_plan.md`): handwriting
 * with a pen (Apple Pencil, a stylus), highlighter boxes, typed notes, an
 * eraser that takes whole strokes. Saved on the phone as each stroke ends,
 * never sent anywhere until **Submit**, which uploads each marked page's
 * layer, has the desktop bake a marked copy of a PDF, and puts the prompt it
 * answers into this tab's chat.
 *
 * A PDF is drawn by the sealed pdf.js frame (`pdf-frame.html`) — the PWA
 * never parses it; page pictures come back as bitmaps. A picture is shown by
 * the browser itself.
 *
 * Input: a pen always draws and fingers scroll and pinch; while a pen is down
 * every finger is ignored (a resting palm). A device that has not seen a pen
 * gets a ✋ / ✎ switch, and in ✎ one finger draws, two scroll.
 */
export function MarkupView({ tabId, projectId, scope, file, place, onSend, onClose }: {
  tabId: string;
  /** The project the file belongs to — the phone-side layer's key. */
  projectId: string;
  scope: ViewerScope;
  file: OutboxFile;
  /** A project file's folder trail (names), for its layer's key: a file
   * token is sealed afresh with every listing. */
  place?: string;
  /** Sends the desktop's prompt into the chat; `false` when it could not. */
  onSend: (text: string) => boolean;
  onClose: () => void;
}) {
  const t = useT();
  const isPdf = file.kind === "application/pdf";
  const url = viewerFileUrl(scope, file);
  const source = useMemo<MarkupSource>(() => ("files" in scope ? { files: file.ref ?? "" } : { outbox: file.name }), [scope, file.ref, file.name]);
  const key = useMemo(() => layerKey(projectId, "files" in scope ? { files: `${place ?? ""}/${file.name}` } : { outbox: file.name }), [projectId, scope, place, file.name]);
  const fingerprint = useMemo<Fingerprint>(() => ({ size: file.size, modified: file.modified }), [file.size, file.modified]);
  const stem = stemOf(sentName(file));

  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pictures, setPictures] = useState<Record<number, Picture>>({});
  const [pageFailures, setPageFailures] = useState<Set<number>>(() => new Set());
  const [history, setHistory] = useState<History>(() => startHistory());
  const [scratch, setScratch] = useState<Layer | null>(null);
  const [preview, setPreview] = useState<{ n: number; mark: Mark } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storage, setStorage] = useState<"saved" | "unsaved">("saved");
  const [changed, setChanged] = useState(false);
  const [tool, setTool] = useState<Tool>("ink");
  const [color, setColor] = useState<MarkColor>("red");
  const [penSeen, setPenSeen] = useState(readPenSeen);
  const [fingerDraws, setFingerDraws] = useState(false);
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [viewWidth, setViewWidth] = useState(360);
  const [viewHeight, setViewHeight] = useState(640);
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [settledZoom, setSettledZoom] = useState(1);

  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pictureImage = useRef<HTMLImageElement>(null);
  const overlays = useRef(new Map<number, HTMLCanvasElement>());
  const gesture = useRef<Gesture | null>(null);
  const penDown = useRef(false);
  const touches = useRef(new Set<number>());
  const bytes = useRef<ArrayBuffer | null>(null);
  const frameReady = useRef(false);
  const opened = useRef(false);
  const inFlight = useRef<number | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number; mid: [number, number]; left: number; top: number } | null>(null);
  const pageCount = useRef(MAX_FRAME_PAGES);
  const skipSave = useRef(false);
  const renderTimer = useRef<number | undefined>(undefined);
  const sizesRef = useRef<Size[] | null>(null);
  sizesRef.current = sizes;
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;
  const scratchRef = useRef<Layer | null>(null);
  const zoomRef = useRef(zoom);
  const fingerDrawsRef = useRef(false);
  fingerDrawsRef.current = fingerDraws && !penSeen;

  const layer = scratch ?? history.present;
  const baseWidth = Math.max(160, viewWidth - 2 * GAP);
  const cssWidth = baseWidth * zoom;
  const settledWidth = baseWidth * settledZoom;
  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const pixelWidth = Math.min(MAX_RENDER_WIDTH, Math.max(1, Math.round(settledWidth * dpr)));
  const places = useMemo(() => (sizes ? layout(sizes, cssWidth) : []), [sizes, cssWidth]);
  const contentHeight = places.length ? places[places.length - 1].top + places[places.length - 1].height : 0;

  // The pages around the visible ones — what gets a picture and a layer.
  const near = useMemo(() => {
    const result: number[] = [];
    places.forEach((spot, i) => {
      if (spot.top + spot.height >= scrollTop - viewHeight && spot.top <= scrollTop + 2 * viewHeight) result.push(i + 1);
    });
    return result;
  }, [places, scrollTop, viewHeight]);
  const current = useMemo(() => {
    const middle = scrollTop + viewHeight / 2;
    const index = places.findIndex((spot) => middle <= spot.top + spot.height + GAP);
    return index >= 0 ? index + 1 : Math.max(1, places.length);
  }, [places, scrollTop, viewHeight]);
  /** The near pages that get a picture and a layer canvas: the closest to
   * the reader, ties to the earlier page — one ranking for what is kept,
   * what is drawn and what is asked for, so none of them disagree. */
  const alive = useMemo(
    () => [...near].sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b).slice(0, MAX_ALIVE),
    [near, current],
  );

  // The saved layer, once.
  useEffect(() => {
    let live = true;
    void loadLayer(key).then((stored) => {
      if (!live) return;
      if (stored === "unavailable") setStorage("unsaved");
      else if (stored) {
        // Not saved straight back: that would stamp the file's new
        // fingerprint on marks drawn against its old one.
        skipSave.current = true;
        setHistory(startHistory(stored.layer));
        setChanged(stale(stored, fingerprint));
      }
      setLoaded(true);
    });
    return () => { live = false; };
  }, [key, fingerprint]);

  // Saved as each change lands — never before the saved one was read.
  useEffect(() => {
    if (!loaded) return;
    if (skipSave.current) { skipSave.current = false; return; }
    void saveLayer(key, history.present, fingerprint).then((ok) => setStorage(ok ? "saved" : "unsaved"));
  }, [loaded, key, history.present, fingerprint]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setViewWidth(element.clientWidth);
      if (element.clientHeight > 0) setViewHeight(element.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    const target = pendingScroll.current;
    if (!element || !target) return;
    pendingScroll.current = null;
    element.scrollLeft = target.left;
    element.scrollTop = target.top;
  }, [zoom]);

  useEffect(() => {
    // Pages are re-drawn sharper only once a pinch has settled.
    const timer = window.setTimeout(() => setSettledZoom(zoom), 250);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  // --- The sealed frame (PDF only) ------------------------------------------
  const post = useCallback((message: unknown, transfer: Transferable[] = []) => {
    frame.current?.contentWindow?.postMessage(message, "*", transfer);
  }, []);
  /** The page in flight could not be drawn (or never answered): it is marked
   * failed so the queue moves on to the next one. */
  const renderFailed = useCallback((n = inFlight.current) => {
    window.clearTimeout(renderTimer.current);
    if (n === null) return;
    if (inFlight.current === n) inFlight.current = null;
    setPageFailures((known) => new Set(known).add(n));
    setRenderTick((tick) => tick + 1);
  }, []);
  const openIfReady = useCallback(() => {
    if (opened.current || !frameReady.current || !bytes.current) return;
    opened.current = true;
    const data = bytes.current;
    bytes.current = null;
    post({ type: "open", bytes: data }, [data]);
  }, [post]);

  useEffect(() => {
    if (!isPdf) return;
    if (file.size > MAX_INBOX_FILE) { setFailure("tooLarge"); return; }
    const controller = new AbortController();
    void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error("fetch"))))
      .then((data) => {
        if (data.byteLength > MAX_INBOX_FILE) { setFailure("tooLarge"); return; }
        bytes.current = data;
        openIfReady();
      }, () => { if (!controller.signal.aborted) setFailure("fetch"); });
    const timer = window.setTimeout(() => { if (!sizesRef.current) setFailure((was) => was ?? "timeout"); }, OPEN_TIMEOUT);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [isPdf, url, file.size, openIfReady]);

  useEffect(() => {
    if (!isPdf) return;
    const onMessage = (event: MessageEvent) => {
      const message = acceptFrameMessage(event, frame.current?.contentWindow, pageCount.current);
      if (!message) {
        // A page the checks refused still came from the frame: give its
        // bitmap back and let the queue move on rather than wait forever.
        const data = event.data as { type?: unknown; bitmap?: unknown } | null;
        if (frame.current && event.source === frame.current.contentWindow && data && typeof data === "object" && data.type === "page") {
          if (typeof ImageBitmap !== "undefined" && data.bitmap instanceof ImageBitmap) data.bitmap.close();
          renderFailed();
        }
        return;
      }
      if (message.type === "ready") {
        frameReady.current = true;
        openIfReady();
      } else if (message.type === "meta") {
        pageCount.current = message.pages.length;
        setSizes(message.pages.map(({ w, h }) => [w, h]));
      } else if (message.type === "page") {
        window.clearTimeout(renderTimer.current);
        inFlight.current = null;
        setPictures((known) => {
          known[message.n]?.bitmap.close?.();
          return { ...known, [message.n]: { bitmap: message.bitmap, width: message.width } };
        });
        setRenderTick((tick) => tick + 1);
      } else if (message.n !== undefined) {
        renderFailed(message.n);
      } else {
        setFailure(message.code);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isPdf, openIfReady, renderFailed]);

  // One page in flight at a time, the nearest to where the reader is first;
  // pictures far away are let go.
  useEffect(() => {
    if (!isPdf || !sizes || failure) return;
    const keep = new Set(alive);
    setPictures((known) => {
      const drop = Object.keys(known).map(Number).filter((n) => !keep.has(n));
      if (!drop.length) return known;
      const next = { ...known };
      for (const n of drop) { next[n].bitmap.close?.(); delete next[n]; }
      return next;
    });
    if (inFlight.current !== null) return;
    const wanted = alive.find((n) => !pageFailures.has(n) && (!pictures[n] || pictures[n].width < pixelWidth * 0.9));
    if (wanted === undefined) return;
    inFlight.current = wanted;
    post({ type: "render", n: wanted, width: pixelWidth });
    // A frame that never answers (wedged on a hostile page) must not hold
    // up every other page.
    window.clearTimeout(renderTimer.current);
    renderTimer.current = window.setTimeout(() => renderFailed(wanted), RENDER_TIMEOUT);
  }, [isPdf, sizes, failure, alive, pictures, pageFailures, pixelWidth, post, renderTick, renderFailed]);

  useEffect(() => () => {
    // Bitmaps are GPU memory; hand them back as the view goes.
    for (const picture of Object.values(picturesRef.current)) picture.bitmap.close?.();
    window.clearTimeout(renderTimer.current);
  }, []);

  // --- Touch: palm rejection, finger drawing, two-finger pan and pinch -------
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const isStylus = (event: TouchEvent) => [...event.changedTouches].some((touch) => (touch as Touch & { touchType?: string }).touchType === "stylus");
    const onTouchStart = (event: TouchEvent) => {
      // The Pencil would scroll the page and start a text selection.
      if (penDown.current || isStylus(event)) { event.preventDefault(); return; }
      if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        const rect = element.getBoundingClientRect();
        pinch.current = {
          distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom: zoomRef.current,
          mid: [(a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top],
          left: element.scrollLeft,
          top: element.scrollTop,
        };
        event.preventDefault();
        return;
      }
      if (fingerDrawsRef.current && event.touches.length === 1 && (event.target as Element).closest?.(".markup-page-layer")) event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (penDown.current || isStylus(event)) { if (event.cancelable) event.preventDefault(); return; }
      const start = pinch.current;
      if (start && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        const [a, b] = [event.touches[0], event.touches[1]];
        const rect = element.getBoundingClientRect();
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const next = Math.min(MAX_ZOOM, Math.max(1, start.zoom * (start.distance ? distance / start.distance : 1)));
        const mid: [number, number] = [(a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top];
        // What was under the fingers stays under them, and follows them.
        const ratio = next / start.zoom;
        const target = { left: (start.left + start.mid[0]) * ratio - mid[0], top: (start.top + start.mid[1]) * ratio - mid[1] };
        if (next === zoomRef.current) {
          // A plain two-finger drag: nothing re-renders, so scroll now.
          element.scrollLeft = target.left;
          element.scrollTop = target.top;
        } else {
          pendingScroll.current = target;
          zoomRef.current = next;
          setZoom(next);
        }
        return;
      }
      if (fingerDrawsRef.current && gesture.current && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch.current = null;
    };
    element.addEventListener("touchstart", onTouchStart, { passive: false });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);
  // --- Drawing ---------------------------------------------------------------
  const pageSize = (n: number): Size | null => sizes?.[n - 1] ?? null;
  const toPage = (n: number, canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] => {
    const size = pageSize(n)!;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || cssWidth;
    const height = rect.height || cssWidth * size[1] / size[0];
    return clampToPage((clientX - rect.left) * size[0] / width, (clientY - rect.top) * size[1] / height, size);
  };
  const unitsPerPixel = (n: number, canvas: HTMLCanvasElement) => pageSize(n)![0] / (canvas.getBoundingClientRect().width || cssWidth);

  const add = (n: number, mark: Mark) => {
    const size = pageSize(n);
    if (!size) return;
    if (!canAdd(history.present, n, mark)) { setLimitHit(true); return; }
    setLimitHit(false);
    setHistory((now) => commit(now, addMark(now.present, n, size, mark)));
  };

  const onPointerDown = (n: number, event: ReactPointerEvent<HTMLCanvasElement>) => {
    const size = pageSize(n);
    if (!size || sending || !loaded) return;
    if (event.pointerType === "pen") {
      penDown.current = true;
      if (!penSeen) { setPenSeen(true); rememberPen(); }
    } else if (event.pointerType === "touch") {
      touches.current.add(event.pointerId);
      // A resting palm while the pen writes; a second finger is a pinch.
      if (penDown.current) return;
      if (touches.current.size > 1) {
        // The stroke a first finger began gives way to the pinch.
        const abandoned = gesture.current;
        gesture.current = null;
        setPreview(null);
        scratchRef.current = null;
        setScratch(null);
        if (abandoned) overlayRedraw(abandoned.n);
        return;
      }
      if (!fingerDrawsRef.current) return;
    }
    const canvas = event.currentTarget;
    canvas.setPointerCapture?.(event.pointerId);
    const at = toPage(n, canvas, event.clientX, event.clientY);
    if (tool === "ink") {
      const pressure = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
      gesture.current = { kind: "ink", n, pointerId: event.pointerId, last: at, mark: { kind: "ink", color, width: round(Math.min(100, Math.max(0.1, size[0] / 350))), points: [[at[0], at[1], pressure]] } };
      paintPiece(n, at, at, pressure);
    } else if (tool === "box") {
      gesture.current = { kind: "box", n, pointerId: event.pointerId, start: at, end: at };
    } else if (tool === "eraser") {
      gesture.current = { kind: "erase", n, pointerId: event.pointerId };
      scratchRef.current = eraseAt(history.present, n, at[0], at[1], 12 * unitsPerPixel(n, canvas));
      setScratch(scratchRef.current);
    } else {
      gesture.current = { kind: "text", n, pointerId: event.pointerId, start: at, clientX: event.clientX, clientY: event.clientY };
    }
  };

  /** Draws one piece of the stroke in progress straight onto the page's layer
   * canvas — the whole layer is redrawn, curved, when the stroke ends. */
  const paintPiece = (n: number, from: [number, number], to: [number, number], pressure: number) => {
    const canvas = overlays.current.get(n);
    const size = pageSize(n);
    const g = gesture.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !size || !ctx || g?.kind !== "ink") return;
    const scale = canvas.width / size[0];
    ctx.save();
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.strokeStyle = INK[g.mark.color];
    ctx.lineWidth = inkWidth(g.mark.width, pressure);
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
    ctx.restore();
  };
  const overlayRedraw = (n: number) => {
    const canvas = overlays.current.get(n);
    const size = pageSize(n);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !size || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const page = history.present.pages[n];
    if (page) drawPage(ctx, page, canvas.width / size[0]);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const canvas = event.currentTarget;
    if (g.kind === "ink") {
      const native = event.nativeEvent as PointerEvent;
      const samples = native.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [native]) {
        const at = toPage(g.n, canvas, sample.clientX, sample.clientY);
        const pressure = sample.pointerType === "pen" && sample.pressure > 0 ? sample.pressure : 0.5;
        paintPiece(g.n, g.last, at, pressure);
        g.mark.points.push([at[0], at[1], pressure]);
        g.last = at;
      }
    } else if (g.kind === "box") {
      g.end = toPage(g.n, canvas, event.clientX, event.clientY);
      setPreview({ n: g.n, mark: boxOf(g.start, g.end, color) });
    } else if (g.kind === "erase") {
      const at = toPage(g.n, canvas, event.clientX, event.clientY);
      scratchRef.current = eraseAt(scratchRef.current ?? history.present, g.n, at[0], at[1], 12 * unitsPerPixel(g.n, canvas));
      setScratch(scratchRef.current);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "pen") penDown.current = false;
    if (event.pointerType === "touch") touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    const size = pageSize(g.n);
    if (!size) return;
    if (event.type === "pointercancel" && g.kind !== "erase") {
      // A gesture the browser took over (a scroll) is not a mark.
      setPreview(null);
      overlayRedraw(g.n);
      return;
    }
    if (g.kind === "ink") {
      add(g.n, finishStroke(g.mark, size));
    } else if (g.kind === "box") {
      setPreview(null);
      const box = boxOf(g.start, g.end, color);
      if (box.rect[2] >= 2 && box.rect[3] >= 2) add(g.n, box);
    } else if (g.kind === "erase") {
      const erased = scratchRef.current;
      scratchRef.current = null;
      setScratch(null);
      if (erased) setHistory((now) => commit(now, erased));
    } else if (Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < 12) {
      // A tap: edit the note under it, or start a new one there.
      const page = history.present.pages[g.n];
      const index = page ? page.marks.findIndex((mark) => mark.kind === "text" && insideBox(textBox(mark), g.start)) : -1;
      const existing = index >= 0 ? (page!.marks[index] as TextMark) : null;
      setNote(existing
        ? { n: g.n, at: existing.at, index, text: existing.text, color: existing.color, size: existing.size }
        : { n: g.n, at: [round(g.start[0]), round(g.start[1])], index: null, text: "", color, size: Math.min(200, Math.max(4, Math.round(size[0] / 40))) });
    }
  };
  const handlers = { onPointerDown, onPointerMove, onPointerUp };

  /** `text` null deletes the note being edited. */
  const saveNote = (text: string | null) => {
    const draft = note;
    setNote(null);
    if (!draft) return;
    // Every control character but the line break — the desktop refuses them.
    const clean = (text ?? "").replace(/(?!\n)\p{Cc}/gu, "").trim();
    const mark: TextMark | null = clean ? { kind: "text", color: draft.color, at: draft.at, size: draft.size, text: clean } : null;
    if (draft.index !== null) {
      if (mark && !canReplace(history.present, draft.n, draft.index, mark)) { setLimitHit(true); return; }
      setHistory((now) => commit(now, replaceMark(now.present, draft.n, draft.index!, mark)));
    } else if (mark) {
      add(draft.n, mark);
    }
  };

  // --- Submit ----------------------------------------------------------------
  const reason = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "";
    return REASON_KEYS[code] ? t(REASON_KEYS[code]) : t("mobile.markup.reason.other", { code: code || "error" });
  };
  const submit = async () => {
    const marked = markedPages(history.present);
    if (!marked.length || sending) return;
    setSendFailure(null);
    const refs = new Map<number, string>();
    for (const n of marked) {
      setSending(t("mobile.markup.sendingPage", { n }));
      try {
        const png = await layerPng(history.present.pages[n]);
        refs.set(n, (await uploadToInbox(tabId, png, `${stem}-p${n}-layer.png`)).reference);
      } catch (error) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.layer", { n, reason: reason(error) }));
        return;
      }
    }
    let picture: string | undefined;
    if (!isPdf) {
      setSending(t("mobile.markup.sendingPicture"));
      try {
        const image = pictureImage.current;
        if (!image) throw new Error("picture");
        picture = (await uploadToInbox(tabId, await composedPng(image, history.present.pages[1]), `${stem}-marked.png`)).reference;
      } catch (error) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.picture", { reason: reason(error) }));
        return;
      }
    }
    setSending(t("mobile.markup.sendingMarks"));
    let prompt: string;
    try {
      prompt = (await submitMarkup(tabId, {
        source,
        pages: marked.map((n) => ({ n, size: history.present.pages[n].size, marks: history.present.pages[n].marks, layer: refs.get(n)! })),
        ...(picture ? { picture } : {}),
      })).prompt;
    } catch (error) {
      setSending(null);
      setSendFailure(t("mobile.markup.sendFailed.marks", { reason: reason(error) }));
      return;
    }
    if (!onSend(prompt)) {
      setSending(null);
      setSendFailure(t("mobile.markup.sendFailed.chat"));
      return;
    }
    await clearLayer(key);
    setSending(null);
    onClose();
  };

  const empty = isEmpty(history.present);
  const untested = isUntested("mobile.markup") || isUntested("mobile.markup.send") || (isPdf && isUntested("mobile.markup.frame"));
  const register = useCallback((n: number, canvas: HTMLCanvasElement | null) => {
    if (canvas) overlays.current.set(n, canvas);
    else overlays.current.delete(n);
  }, []);

  return <div className="outbox-viewer markup-view" role="dialog" aria-modal="true" aria-label={t("mobile.markup.title", { name: sentName(file) })}>
    <div className="outbox-viewer-head">
      <button className="sheet-close" onClick={onClose} aria-label={t("mobile.markup.close")} disabled={sending !== null}>✕</button>
      <div className="outbox-viewer-title">
        <h2>{sentName(file)}</h2>
        <small>{t("mobile.markup.subtitle")}{untested && <span className="untested">{t("mobile.outbox.untested")}</span>}</small>
      </div>
      <button className="markup-submit" disabled={empty || sending !== null || !online} onClick={() => void submit()} title={t("mobile.markup.submitTitle")}>
        {t("mobile.markup.submit")}
      </button>
    </div>
    <div className="markup-notes">
      {storage === "unsaved" && <p role="status">{t("mobile.markup.unsaved")}</p>}
      {changed && <p role="status">{t("mobile.markup.changed")}</p>}
      {limitHit && <p role="alert">{t("mobile.markup.limit")}</p>}
      {sending && <p role="status">{sending}</p>}
      {sendFailure && <p role="alert">{sendFailure}</p>}
      {failure && <p role="alert">{t(FAILURE_KEYS[failure])}</p>}
    </div>
    <div ref={scroller} className={`markup-scroller${fingerDrawsRef.current ? " finger-draws" : ""}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      {isPdf ? <>
        {!sizes && !failure && <p className="markup-loading">{t("mobile.markup.loading")}</p>}
        {sizes && <div className="markup-pages" style={{ width: cssWidth, height: contentHeight }}>
          {sizes.map((size, i) => {
            const n = i + 1;
            const spot = places[i];
            const shown = alive.includes(n);
            return <div key={n} className="markup-page" style={{ top: spot.top, width: cssWidth, height: spot.height }} aria-label={t("mobile.markup.page", { n })}>
              {shown && <>
                <PagePicture picture={pictures[n]} />
                {!pictures[n] && <span className="markup-page-note">{t(pageFailures.has(n) ? "mobile.markup.pageFailed" : "mobile.markup.pageLoading", { n })}</span>}
                <LayerCanvas n={n} size={size} page={layer.pages[n]} preview={preview?.n === n ? preview.mark : null} pixelWidth={pixelWidth} register={register} handlers={handlers} />
              </>}
              {note?.n === n && <NoteEditor note={note} size={size} width={cssWidth} onSave={saveNote} onCancel={() => setNote(null)} />}
            </div>;
          })}
        </div>}
        {!failure && <iframe ref={frame} className="markup-frame" title="pdf" sandbox="allow-scripts" src="/pdf-frame.html" />}
      </> : <div className="markup-pages markup-picture" style={{ width: cssWidth }}>
        <div className="markup-page" style={sizes ? { width: cssWidth, height: cssWidth * sizes[0][1] / sizes[0][0] } : { width: cssWidth }}>
          <img ref={pictureImage} src={url} alt={sentName(file)} draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setSizes([[naturalWidth, naturalHeight]]);
              else setFailure("picture");
            }}
            onError={() => setFailure("picture")} />
          {sizes && <LayerCanvas n={1} size={sizes[0]} page={layer.pages[1]} preview={preview?.n === 1 ? preview.mark : null} pixelWidth={pixelWidth} register={register} handlers={handlers} />}
          {sizes && note?.n === 1 && <NoteEditor note={note} size={sizes[0]} width={cssWidth} onSave={saveNote} onCancel={() => setNote(null)} />}
        </div>
      </div>}
    </div>
    <div className="markup-toolbar" role="toolbar" aria-label={t("mobile.markup.tools")}>
      {(["ink", "box", "text", "eraser"] as Tool[]).map((name) => <button key={name} aria-pressed={tool === name} className={tool === name ? "selected" : ""}
        onClick={() => { setTool(name); if (name === "box" && color !== "yellow") setColor("yellow"); if (name === "ink" && color === "yellow") setColor("red"); }}
        aria-label={t(`mobile.markup.tool.${name}` as TranslationKey)} title={t(`mobile.markup.tool.${name}` as TranslationKey)}>
        <span aria-hidden="true">{name === "ink" ? "✎" : name === "box" ? "▭" : name === "text" ? "T" : "⌫"}</span>
      </button>)}
      <span className="markup-colors" role="group" aria-label={t("mobile.markup.color")}>
        {MARK_COLORS.map((name) => <button key={name} className={`markup-color${color === name ? " selected" : ""}`} aria-pressed={color === name}
          style={{ background: INK[name] }} onClick={() => setColor(name)} aria-label={t(`mobile.markup.color.${name}` as TranslationKey)} />)}
      </span>
      <button onClick={() => setHistory(undo)} disabled={!history.past.length} aria-label={t("mobile.markup.undo")} title={t("mobile.markup.undo")}><span aria-hidden="true">↶</span></button>
      <button onClick={() => setHistory(redo)} disabled={!history.future.length} aria-label={t("mobile.markup.redo")} title={t("mobile.markup.redo")}><span aria-hidden="true">↷</span></button>
      <button onClick={() => setHistory((now) => commit(now, clearPage(now.present, current)))} disabled={!history.present.pages[current]}
        aria-label={t("mobile.markup.clearPage", { n: current })} title={t("mobile.markup.clearPage", { n: current })}><span aria-hidden="true">⌧</span></button>
      {!penSeen && <button className={fingerDraws ? "selected" : ""} aria-pressed={fingerDraws} onClick={() => setFingerDraws((on) => !on)}
        aria-label={t(fingerDraws ? "mobile.markup.fingerDraws" : "mobile.markup.fingerScrolls")} title={t(fingerDraws ? "mobile.markup.fingerDraws" : "mobile.markup.fingerScrolls")}>
        <span aria-hidden="true">{fingerDraws ? "✎" : "✋"}</span>
      </button>}
    </div>
  </div>;
}

function boxOf(a: [number, number], b: [number, number], color: MarkColor): BoxMark {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { kind: "box", color, rect: [round(x), round(y), round(Math.abs(a[0] - b[0])), round(Math.abs(a[1] - b[1]))] };
}

function insideBox([x, y, w, h]: [number, number, number, number], [px, py]: [number, number]): boolean {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

/** The typed note, edited where it sits on the page. */
function NoteEditor({ note, size, width, onSave, onCancel }: { note: NoteDraft; size: Size; width: number; onSave: (text: string | null) => void; onCancel: () => void }) {
  const t = useT();
  const [text, setText] = useState(note.text);
  const scale = width / size[0];
  return <div className="markup-note-editor" style={{ left: Math.min(note.at[0] * scale, Math.max(0, width - 220)), top: note.at[1] * scale }}>
    <textarea autoFocus value={text} maxLength={2000} placeholder={t("mobile.markup.notePlaceholder")} onChange={(event) => setText(event.target.value)}
      style={{ color: INK[note.color] }} aria-label={t("mobile.markup.notePlaceholder")} />
    <div>
      {note.index !== null && <button onClick={() => onSave(null)}>{t("mobile.markup.noteDelete")}</button>}
      <button onClick={onCancel}>{t("mobile.markup.noteCancel")}</button>
      <button onClick={() => onSave(text)} disabled={!text.trim()}>{t("mobile.markup.noteDone")}</button>
    </div>
  </div>;
}
