/**
 * Playing a GIF interstitial — the clip that runs *between* two slides, which is
 * the only way a TeX-generated PDF can carry animation at all.
 *
 * It reuses the repo's existing pure decoder (`lib/viewers/gif.ts`), so it adds
 * no dependency and inherits that module's delay conventions. Two facts from the
 * decoder shape everything here:
 *
 * **Every frame is a full-canvas RGBA copy.** A 1920×1080 GIF costs ~8.3 MB *per
 * frame*, so a 30-frame clip reaches the decoder's 256 MB default cap. A slide
 * deck can hold several interstitials, so this module passes a much smaller
 * explicit budget and pre-bakes frames to `ImageBitmap` — `putImageData` ignores
 * transforms and so cannot scale, whereas `drawImage` of a bitmap can.
 *
 * **Delays are authored, played by convention.** `effectiveDelayMs` maps the
 * sub-20 ms delays real files contain onto the 100 ms browsers actually use.
 *
 * The playback clock is `GifView`'s accumulator, lifted deliberately rather than
 * rewritten: it banks elapsed wall-clock, may advance several frames in one tick,
 * never drifts, and clamps the backlog so a presenter window that was occluded
 * does not spin through a thousand frames when it comes back.
 */

import { effectiveDelayMs, openGif } from "../../../lib/viewers/gif";

/** Per-interstitial decode budget. Well under the decoder's default: a deck may
 *  hold several clips, and a presenter that OOMs mid-talk is unforgivable. */
export const INTERSTITIAL_PIXEL_BUDGET = 48 * 1024 * 1024;

/** The most elapsed time one tick may bank, so an occluded window catches up
 *  rather than replaying minutes of animation. */
const MAX_CARRY_MS = 2000;

export interface DecodedGif {
  width: number;
  height: number;
  frames: Array<{ bitmap: ImageBitmap; delayMs: number }>;
  loopCount: number;
  truncated: boolean;
}

/** Decode `bytes` and pre-bake every frame to an `ImageBitmap`. */
export async function decodeInterstitial(bytes: Uint8Array): Promise<DecodedGif> {
  const stream = openGif(bytes, { maxPixelBytes: INTERSTITIAL_PIXEL_BUDGET });
  const frames: DecodedGif["frames"] = [];
  for (let f = stream.nextFrame(); f; f = stream.nextFrame()) {
    const image = new ImageData(f.pixels, stream.width, stream.height);
    frames.push({
      bitmap: await createImageBitmap(image),
      delayMs: effectiveDelayMs(f.delayMs),
    });
  }
  return {
    width: stream.width,
    height: stream.height,
    frames,
    loopCount: stream.loopCount,
    truncated: stream.truncated,
  };
}

/** Release the bitmaps. They are GPU-side; letting them fall out of scope is not
 *  enough on a long-lived presenter. */
export function disposeGif(gif: DecodedGif | null): void {
  gif?.frames.forEach((f) => f.bitmap.close());
}

export interface PlayOptions {
  /** Letterbox (`contain`) or fill and crop (`cover`). */
  fit: "contain" | "cover";
  /** Colour behind a letterboxed clip. */
  background: string;
  /** Loop forever, or stop on the last frame. */
  loop: boolean;
  /** Called after the clip's final pass — drives auto-advance. */
  onEnded?: () => void;
}

/**
 * Drive `gif` onto `canvas` until the returned function is called.
 *
 * Returns a stop function; it is safe to call more than once.
 */
export function playGif(
  canvas: HTMLCanvasElement,
  gif: DecodedGif,
  opts: PlayOptions,
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx || gif.frames.length === 0) return () => {};

  let raf = 0;
  let stopped = false;
  let index = 0;
  let carry = 0;
  let last = 0;
  let ended = false;

  const paint = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const bw = Math.floor(cssW * dpr);
    const bh = Math.floor(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const scale =
      opts.fit === "cover"
        ? Math.max(canvas.width / gif.width, canvas.height / gif.height)
        : Math.min(canvas.width / gif.width, canvas.height / gif.height);
    const w = gif.width * scale;
    const h = gif.height * scale;
    ctx.drawImage(gif.frames[index].bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };

  const tick = (ts: number) => {
    if (stopped) return;
    if (last === 0) last = ts;
    if (!ended) {
      carry = Math.min(carry + (ts - last), MAX_CARRY_MS);
      let delay = gif.frames[index].delayMs;
      while (carry >= delay) {
        carry -= delay;
        if (index === gif.frames.length - 1) {
          if (!opts.loop) {
            ended = true;
            opts.onEnded?.();
            break;
          }
          index = 0;
        } else {
          index += 1;
        }
        delay = gif.frames[index].delayMs;
      }
    }
    last = ts;
    paint();
    raf = requestAnimationFrame(tick);
  };

  paint();
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

/**
 * Encode one frame as PNG bytes — the poster the PDF export writes in place of
 * the animation, since a GIF cannot be a PDF page.
 *
 * Lives here rather than in `deck/export.ts` because it needs a canvas, and
 * keeping the exporter DOM-free is what makes it testable.
 */
export async function posterPng(gif: DecodedGif, frame: number): Promise<Uint8Array | null> {
  const f = gif.frames[Math.min(Math.max(frame, 0), gif.frames.length - 1)];
  if (!f) return null;
  const canvas = document.createElement("canvas");
  canvas.width = gif.width;
  canvas.height = gif.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(f.bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
