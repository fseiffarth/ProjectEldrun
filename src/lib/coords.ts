/**
 * #42: canonical cross-window coordinate space for the detached drag-drop system.
 *
 * THE CANONICAL SPACE IS PHYSICAL DESKTOP PIXELS. Five of the six Tauri geometry
 * primitives the drag pipeline uses (`cursorPosition`, `outerPosition`,
 * `outerSize`, `innerPosition`, `setPosition`) are physical and live in
 * one global desktop frame, so we standardise on physical and ELIMINATE the only
 * platform-divergent quantity — DOM `screenX/screenY`, whose units differ between
 * WebKitGTK (Linux), WebView2 (Windows), and WKWebView (macOS) under DPI scaling.
 *
 * Why physical and not "logical desktop px" (the old implicit convention)? Logical
 * desktop px is ill-defined under mixed-DPI multi-monitor: it divides a global
 * cursor by one window's scale and subtracts another window's origin divided by a
 * DIFFERENT scale. Physical has no such ambiguity — each window converts physical
 * → its-own-client px AT THE LEAF, dividing by ITS OWN scale, the only DPI-correct
 * place to divide. At the common `scaleFactor == 1` (e.g. the dev Linux box)
 * physical == logical, so adopting physical changes nothing observable there.
 * Native Wayland exposes no desktop coordinates; the capability guard below
 * refuses its dummy readings. Local tab gestures must use DOM client coordinates.
 */
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import type { Window } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { IS_LINUX } from "./platform";

// A native Wayland window has no global origin, and tao's cursorPosition returns
// a successful dummy (0, 0). Never feed those values into cross-window hit tests.
// Older backends cannot answer: keep local dragging available and decline global
// geometry on Linux until the user deliberately restarts into the updated binary.
let coordinateSupport: Promise<boolean> | undefined;
export function desktopCoordinatesSupported(): Promise<boolean> {
  return coordinateSupport ??= IS_LINUX
    ? invoke<boolean>("desktop_coordinates_supported").then((supported) => supported === true).catch(() => false)
    : Promise.resolve(true);
}

async function requireDesktopCoordinates() {
  if (!(await desktopCoordinatesSupported())) throw new Error("Desktop coordinates unavailable");
}

/** A point in physical desktop px (the canonical cross-window space). */
export interface PhysPoint {
  x: number;
  y: number;
}
/** A point in a window's own CSS/client px (its `getBoundingClientRect` space). */
export interface ClientPoint {
  x: number;
  y: number;
}

/**
 * A window's geometry snapshot, captured ONCE at gesture start (a window doesn't
 * move/rescale mid-gesture for our purposes — and when it does, the dock-back
 * follow re-snapshots). All `*Phys` fields are physical desktop px.
 */
export interface WindowFrame {
  /** Client-area (content) top-left, physical px. The ONLY origin used to map a
   *  cursor into this window's client px — never `outerPhys`, so an invisible
   *  frame/shadow (Windows) or title-bar area (macOS) can't skew the mapping. */
  innerPhys: PhysPoint;
  /** Window top-left INCLUDING the frame, physical px. Used only for the outer
   *  AABB hit-test (is the cursor over this window at all). */
  outerPhys: PhysPoint;
  /** Outer window size, physical px. */
  outerSize: { w: number; h: number };
  /** This window's device-pixel ratio (logical→physical scale factor). */
  scale: number;
}

/**
 * Snapshot a window's frame. Reads `innerPosition`, `outerPosition`, `outerSize`,
 * and `scaleFactor` (all permitted via `core:default` — no capability change).
 * Defaults to the current window.
 */
export async function snapshotFrame(win: Window = getCurrentWindow()): Promise<WindowFrame> {
  await requireDesktopCoordinates();
  const [inner, outer, size, scale] = await Promise.all([
    win.innerPosition(),
    win.outerPosition(),
    win.outerSize(),
    win.scaleFactor(),
  ]);
  return {
    innerPhys: { x: inner.x, y: inner.y },
    outerPhys: { x: outer.x, y: outer.y },
    outerSize: { w: size.width, h: size.height },
    scale: scale || 1,
  };
}

/** physical desktop px → this window's client CSS px. Uses `innerPhys` (NOT
 *  `outerPhys`), so the frame/title-bar offset never enters the mapping. */
export const physToClient = (f: WindowFrame, p: PhysPoint): ClientPoint => ({
  x: (p.x - f.innerPhys.x) / f.scale,
  y: (p.y - f.innerPhys.y) / f.scale,
});

/** this window's client CSS px → physical desktop px. Valid for points OUTSIDE
 *  the viewport too (pure linear extrapolation), so it can seed a gesture from a
 *  DOM `clientX/clientY` that began inside the window. */
export const clientToPhys = (f: WindowFrame, c: ClientPoint): PhysPoint => ({
  x: f.innerPhys.x + c.x * f.scale,
  y: f.innerPhys.y + c.y * f.scale,
});

/** Is the physical point inside this window's OUTER rect? Pure AABB, no scale
 *  involved (both operands are physical). */
export const pointInOuter = (f: WindowFrame, p: PhysPoint): boolean =>
  p.x >= f.outerPhys.x &&
  p.x <= f.outerPhys.x + f.outerSize.w &&
  p.y >= f.outerPhys.y &&
  p.y <= f.outerPhys.y + f.outerSize.h;

/** The OS cursor in physical desktop px (`cursorPosition` is already physical and
 *  is the proven cross-platform position source for the dock-back path). */
export const desktopCursor = async (): Promise<PhysPoint> => {
  await requireDesktopCoordinates();
  const p = await cursorPosition();
  return { x: p.x, y: p.y };
};

/**
 * Poll `cursorPosition()` every ~16ms and report each reading (physical px). This
 * is the SOURCE OF TRUTH for cross-window position: DOM pointer events don't
 * reliably cross OS window boundaries (WebKitGTK) and report divergent units
 * (WebView2/WKWebView), whereas `cursorPosition()` is desktop-global and physical
 * on every engine. Returns a stop function. Uses `setInterval` (NOT rAF — must
 * keep firing while the source window is unfocused) with a re-entrancy guard so a
 * slow `cursorPosition()` await can't overlap itself.
 */
export function startCursorPoll(onTick: (p: PhysPoint) => void): () => void {
  let stopped = false;
  let inFlight = false;
  const id = window.setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void desktopCursor()
      .then((p) => {
        if (!stopped) onTick({ x: p.x, y: p.y });
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }, 16);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}
