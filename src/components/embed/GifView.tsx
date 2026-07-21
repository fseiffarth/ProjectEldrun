import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ViewerHeader,
  useViewerState,
  useNonPassiveWheel,
  zoomOffset,
  clampScale,
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_STEP,
} from "./FileViewerPane";
import { useFileScope, readFileBytes, fileMtime } from "./fileAccess";
import { openGif, effectiveDelayMs } from "../../lib/viewers/gif";
import { Dropdown } from "../common/Dropdown";

/**
 * Animated-GIF viewer with frame-level transport (#gifviewer). The plain image
 * viewer already *animates* a GIF — the webview animates <img> natively — but
 * offers no control over the animation. This viewer decodes the frames itself
 * (`lib/viewers/gif.ts`; WebKitGTK has no ImageDecoder API) and plays them on a
 * <canvas>, which is what makes pause, frame stepping, scrubbing, speed and
 * loop control possible at all.
 *
 * Playback honors each frame's own delay through a timestamp accumulator (a
 * fixed-interval timer would drift and ignore per-frame timing); authored
 * sub-20ms delays play at the 100ms browser convention (`effectiveDelayMs`).
 * Zoom/pan mirrors the image viewer exactly, sharing its exported pure pieces
 * (`zoomOffset`/`clampScale`/`useNonPassiveWheel`) and persisting the view per
 * tab the same way.
 *
 * Decoding runs on the main thread but yields to the event loop every few
 * frames — no Web Worker: typical GIFs decode in single-digit ms, and shipping
 * hundreds of MB of frame buffers through structured clone would cost more
 * than it saves. A GIF the decoder can't handle degrades to the plain <img>
 * (which still animates natively) rather than a wall — a decoder gap must
 * never render worse than before this viewer existed.
 *
 * No Annotate button: the annotator flattens to a single PNG, which would
 * silently destroy the animation on save. (A possible future affordance is
 * "annotate the CURRENT frame → PNG copy".)
 */

/** Mirrors FileViewerPane's RELOAD_POLL_MS (#68 auto-reload). */
const RELOAD_POLL_MS = 1500;

/** Bound the accumulator so a long-hidden tab (rAF suspended) fast-forwards at
 *  most this much wall-clock time instead of spinning the advance loop. */
const MAX_CARRY_MS = 60_000;

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 4].map((s) => ({
  value: String(s),
  label: `${s}×`,
}));

/**
 * Load `path`'s raw bytes (the decoder wants bytes, not a blob URL) and re-read
 * them when the file changes on disk — the byte-level twin of FileViewerPane's
 * `useBlobUrl`. A same-path reload keeps the current bytes up until the fresh
 * ones arrive, so the animation doesn't flash to a loading state.
 */
function useGifBytes(path: string) {
  const scope = useFileScope();
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastMtime = useRef<number | null>(null);
  // Bumped whenever the file's mtime advances on disk, forcing a byte reload.
  const [diskVersion, setDiskVersion] = useState(0);

  // Reset to the loading state only on a genuine file switch.
  useEffect(() => {
    setBytes(null);
    setError(null);
    lastMtime.current = null;
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    readFileBytes(path, scope)
      .then((b) => {
        if (!cancelled) setBytes(Uint8Array.from(b));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, scope, diskVersion]);

  // Poll mtime; on an external advance, bump diskVersion to re-read fresh bytes.
  useEffect(() => {
    let cancelled = false;
    fileMtime(path, scope)
      .then((m) => {
        if (!cancelled) lastMtime.current = m;
      })
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
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [path, scope]);

  return { bytes, error };
}

/** Decoded frames with their ImageData built once (zero-copy wrap of the
 *  decoder's RGBA buffers), so drawing a frame is a single putImageData. */
interface DecodedGif {
  width: number;
  height: number;
  frames: { image: ImageData; delayMs: number }[];
  truncated: boolean;
}

export function GifView({
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
  const { bytes, error } = useGifBytes(path);

  // ── Decode ──────────────────────────────────────────────────────────────────
  const [decoded, setDecoded] = useState<DecodedGif | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  // A genuine file switch drops the previous animation; a same-path disk reload
  // (bytes swap) keeps it up until the fresh decode lands.
  useEffect(() => {
    setDecoded(null);
    setDecodeError(null);
  }, [path]);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = openGif(bytes);
        const frames: DecodedGif["frames"] = [];
        for (let f = stream.nextFrame(); f !== null; f = stream.nextFrame()) {
          frames.push({
            image: new ImageData(f.pixels, stream.width, stream.height),
            delayMs: f.delayMs,
          });
          // Yield to the event loop every few frames so a huge GIF can't jank
          // the whole window while it decodes.
          if (frames.length % 10 === 0) {
            await new Promise((r) => setTimeout(r));
            if (cancelled) return;
          }
        }
        if (frames.length === 0) throw new Error("GIF contains no image frames");
        if (!cancelled) {
          setDecoded({
            width: stream.width,
            height: stream.height,
            frames,
            truncated: stream.truncated,
          });
          setDecodeError(null);
        }
      } catch (e) {
        if (!cancelled) setDecodeError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const frameCount = decoded?.frames.length ?? 0;

  // ── Transport state ─────────────────────────────────────────────────────────
  // Autoplay by default: that's exactly what the old <img> rendering did.
  const [playing, setPlaying] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  // Mirrors frameIndex for the playback loop, which advances between renders.
  const frameIndexRef = useRef(0);
  frameIndexRef.current = frameIndex;

  // Reset the transport on a file switch (not on a same-path reload — but if a
  // reload shrank the file, clamp so the index stays addressable).
  useEffect(() => {
    setPlaying(true);
    setFrameIndex(0);
    frameIndexRef.current = 0;
  }, [path]);
  useEffect(() => {
    if (decoded && frameIndexRef.current >= decoded.frames.length) {
      setFrameIndex(decoded.frames.length - 1);
    }
  }, [decoded]);

  // The playback loop: a rAF-driven timestamp accumulator. Each tick banks the
  // elapsed wall-clock time (× speed) and advances as many frames as it pays
  // for — possibly several per tick at high speed — so playback never drifts
  // and per-frame delays are honored exactly.
  useEffect(() => {
    if (!playing || !decoded || decoded.frames.length < 2) return;
    let raf = 0;
    let lastTs: number | null = null;
    let carry = 0;
    const tick = (ts: number) => {
      if (lastTs != null) {
        carry = Math.min(carry + (ts - lastTs) * speed, MAX_CARRY_MS);
        let i = frameIndexRef.current;
        let advanced = false;
        let ended = false;
        let delay = effectiveDelayMs(decoded.frames[i].delayMs);
        while (carry >= delay) {
          carry -= delay;
          if (i === decoded.frames.length - 1) {
            if (!loop) {
              ended = true;
              break;
            }
            i = 0;
          } else {
            i++;
          }
          advanced = true;
          delay = effectiveDelayMs(decoded.frames[i].delayMs);
        }
        if (advanced) {
          frameIndexRef.current = i;
          setFrameIndex(i);
        }
        if (ended) {
          setPlaying(false);
          return; // effect teardown cancels; don't schedule another tick
        }
      }
      lastTs = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, decoded, speed, loop]);

  // ── Canvas ──────────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!decoded) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const frame = decoded.frames[Math.min(frameIndex, decoded.frames.length - 1)];
    ctx.putImageData(frame.image, 0, 0);
  }, [decoded, frameIndex]);

  // ── Zoom / pan (mirrors ImageView) ──────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const fittedRef = useRef(true);
  const dimsRef = useRef<{ w: number; h: number } | null>(null);

  const viewportSize = () => {
    const el = viewportRef.current;
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
  };

  // Fit scale — never upscales past 1:1, so small GIFs stay crisp.
  const fitScaleFor = useCallback((nat: { w: number; h: number }, vp: { w: number; h: number }) => {
    if (nat.w === 0 || nat.h === 0 || vp.w === 0 || vp.h === 0) return 1;
    return Math.min(vp.w / nat.w, vp.h / nat.h, 1);
  }, []);

  const fit = useCallback(() => {
    const nat = dimsRef.current;
    if (!nat) return;
    const vp = viewportSize();
    const s = fitScaleFor(nat, vp);
    setScale(s);
    setOffset({ x: (vp.w - nat.w * s) / 2, y: (vp.h - nat.h * s) / 2 });
    fittedRef.current = true;
  }, [fitScaleFor]);

  const zoomTo = useCallback((target: number, anchor?: { x: number; y: number }) => {
    const vp = viewportSize();
    const a = anchor ?? { x: vp.w / 2, y: vp.h / 2 };
    setScale((prev) => {
      const next = clampScale(target);
      setOffset((o) => zoomOffset(prev, next, o, a));
      return next;
    });
    fittedRef.current = false;
  }, []);

  // First decode: restore the session-persisted zoom/pan (#viewerpos) or fit.
  // A re-decode with different dimensions (file replaced on disk) re-fits; a
  // same-size content update keeps the user's view.
  useEffect(() => {
    if (!decoded) return;
    const nat = { w: decoded.width, h: decoded.height };
    const prev = dimsRef.current;
    dimsRef.current = nat;
    if (!prev) {
      const init = viewPos.initial;
      if (init?.scale != null) {
        setScale(init.scale);
        setOffset({ x: init.offsetX ?? 0, y: init.offsetY ?? 0 });
        fittedRef.current = false;
        return;
      }
      fit();
      return;
    }
    if (prev.w !== nat.w || prev.h !== nat.h) fit();
  }, [decoded, fit, viewPos]);
  useEffect(() => {
    dimsRef.current = null; // a file switch re-fits from scratch
  }, [path]);

  // #viewerpos: persist zoom + pan (throttled, trailing-edge).
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!decoded) return;
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
  }, [scale, offset, decoded, viewPos]);

  // Re-fit on viewport resize while still in the fitted baseline state.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fittedRef.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, decoded]);

  const wheelRef = useNonPassiveWheel((e) => {
    if (!decoded) return;
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomTo(scale * factor, anchor);
  });
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
    if (!decoded || e.button !== 0) return;
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
    const nat = dimsRef.current;
    if (!nat) return;
    const atFit = Math.abs(scale - fitScaleFor(nat, viewportSize())) < 0.001;
    if (atFit) {
      const rect = viewportRef.current?.getBoundingClientRect();
      const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
      zoomTo(1, anchor);
    } else {
      fit();
    }
  };

  // ── Transport handlers ──────────────────────────────────────────────────────
  // Stepping/scrubbing pauses: you asked for a specific frame, hold it.
  const stepTo = (i: number) => {
    setPlaying(false);
    setFrameIndex(i);
  };
  const prevFrame = () => stepTo(frameIndex === 0 ? frameCount - 1 : frameIndex - 1);
  const nextFrame = () => stepTo((frameIndex + 1) % frameCount);
  // The scrubber pauses while dragging and resumes only if it was playing.
  const scrubWasPlaying = useRef(false);
  const onScrubDown = () => {
    scrubWasPlaying.current = playing;
    setPlaying(false);
  };
  const onScrubUp = () => {
    if (scrubWasPlaying.current) setPlaying(true);
    scrubWasPlaying.current = false;
  };

  // Decode failure → degrade to the webview's native <img> animation.
  const fallbackUrl = useMemo(() => {
    if (decodeError == null || bytes == null) return null;
    return URL.createObjectURL(new Blob([bytes]));
  }, [decodeError, bytes]);
  useEffect(
    () => () => {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
    },
    [fallbackUrl],
  );

  const percent = Math.round(scale * 100);
  const currentDelay = decoded ? decoded.frames[Math.min(frameIndex, frameCount - 1)].delayMs : 0;
  const shownDelay = effectiveDelayMs(currentDelay);

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {decoded != null && (
          <div className="file-viewer-zoom gif-transport" role="group" aria-label="Playback controls">
            <button
              className="file-viewer-zoom-btn"
              onClick={prevFrame}
              disabled={frameCount < 2}
              title="Previous frame"
              aria-label="Previous frame"
            >
              ⏮
            </button>
            <button
              className="file-viewer-zoom-btn"
              onClick={() => setPlaying((p) => !p)}
              disabled={frameCount < 2}
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              className="file-viewer-zoom-btn"
              onClick={nextFrame}
              disabled={frameCount < 2}
              title="Next frame"
              aria-label="Next frame"
            >
              ⏭
            </button>
            <input
              type="range"
              className="gif-scrubber"
              min={0}
              max={Math.max(frameCount - 1, 0)}
              value={Math.min(frameIndex, frameCount - 1)}
              disabled={frameCount < 2}
              onPointerDown={onScrubDown}
              onPointerUp={onScrubUp}
              onChange={(e) => setFrameIndex(Number(e.target.value))}
              title="Scrub frames"
              aria-label="Frame scrubber"
            />
            <Dropdown
              className="gif-speed"
              value={String(speed)}
              options={SPEED_OPTIONS}
              onChange={(v) => setSpeed(Number(v))}
              title="Playback speed"
            />
            <button
              className="file-viewer-zoom-btn"
              onClick={() => setLoop((l) => !l)}
              title={loop ? "Looping — click to play once" : "Play once — click to loop"}
              aria-label="Loop"
              aria-pressed={loop}
              style={loop ? undefined : { opacity: 0.45 }}
            >
              🔁
            </button>
            <span
              className="file-viewer-zoom-level"
              // The readout shows the delay the frame PLAYS at; when the authored
              // value was bumped by the 100ms convention, the tooltip says so.
              title={
                shownDelay !== currentDelay
                  ? `Authored ${currentDelay} ms; played at the ${shownDelay} ms browser convention`
                  : "Frame / total · frame delay"
              }
            >
              {Math.min(frameIndex + 1, frameCount)} / {frameCount} · {shownDelay} ms
            </span>
          </div>
        )}
        <div className="file-viewer-zoom" role="group" aria-label="Zoom controls">
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale / ZOOM_STEP)}
            disabled={!decoded || scale <= MIN_SCALE}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="file-viewer-zoom-level" title="Current zoom">{percent}%</span>
          <button
            className="file-viewer-zoom-btn"
            onClick={() => zoomTo(scale * ZOOM_STEP)}
            disabled={!decoded || scale >= MAX_SCALE}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => fit()}
            disabled={!decoded}
            title="Fit to window"
          >
            Fit
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={() => zoomTo(1)}
            disabled={!decoded}
            title="Actual size (100%)"
          >
            1:1
          </button>
        </div>
      </ViewerHeader>
      <div className="file-viewer-body file-viewer-image-body">
        {error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : decodeError != null ? (
          // Degrade, don't wall: the webview still animates the <img> natively,
          // so a decoder gap only loses the transport, never the picture.
          <div className="gif-fallback" style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
            <div className="file-viewer-loading" style={{ padding: "4px 8px" }}>
              Couldn't decode this GIF for frame control — showing native playback.
              Try opening it externally if it looks wrong.
            </div>
            {fallbackUrl != null && (
              <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                <img
                  src={fallbackUrl}
                  alt={fileName}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              </div>
            )}
          </div>
        ) : decoded == null ? (
          <div className="file-viewer-loading">{bytes == null ? "Loading…" : "Decoding…"}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
            {decoded.truncated && (
              <div className="file-viewer-loading" style={{ padding: "4px 8px" }}>
                Showing the first {frameCount} frame{frameCount === 1 ? "" : "s"} — the file is
                truncated or exceeds the decode memory cap.
              </div>
            )}
            <div
              ref={setViewport}
              className={`file-viewer-image-viewport${dragging ? " dragging" : ""}`}
              style={{ flex: 1, minHeight: 0 }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={onDoubleClick}
            >
              <canvas
                ref={canvasRef}
                className="file-viewer-image"
                width={decoded.width}
                height={decoded.height}
                aria-label={fileName}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transformOrigin: "0 0",
                  imageRendering: scale > 2 ? "pixelated" : "auto",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
