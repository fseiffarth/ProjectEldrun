import { create } from "zustand";

/**
 * One-shot "fly-out" flourish played when a tab or subwindow is dropped OUT of
 * the main window into its own OS window (another monitor / popout). The new OS
 * window is spawned by the WM under the cursor — often outside this webview — so
 * the only thing we can animate in the main window is a brief send-off: a card
 * at the gesture's last in-window position that lifts, scales, and fades while
 * sliding toward the edge the content exited through, reading as "ejected into
 * its own window."
 *
 * Kept in its own store (mirroring `drag.ts`) so the two detach trigger sites in
 * `TabBar` can fire it and a single overlay in `CenterPanel` can render it,
 * without threading props. The `nonce` lets a repeat detach to the same spot
 * re-trigger the animation; the overlay clears the entry on `animationend`.
 */
export interface DetachFlourish {
  /** Origin (client/CSS px), clamped into the viewport so it's always visible. */
  x: number;
  y: number;
  /** Card size (px) — the dragged pane thumbnail's size, or a sensible default. */
  w: number;
  h: number;
  /** Tab/group label shown on the flying card. */
  label: string;
  /** Fly vector (px) toward the exit edge; the card translates by this as it fades. */
  dx: number;
  dy: number;
  /** Strictly-increasing id so a repeat fly-out re-runs the animation. */
  nonce: number;
}

interface DetachAnimStore {
  flourish: DetachFlourish | null;
  /** Play a fly-out from `(x, y)` toward `(dx, dy)`. Coords are clamped to the
   *  viewport so an off-window drop still animates at the nearest visible edge. */
  flyOut: (f: Omit<DetachFlourish, "nonce" | "dx" | "dy"> & { dx?: number; dy?: number }) => void;
  /** Clear the flourish once its animation has finished (matched by `nonce`). */
  clear: (nonce: number) => void;
}

// Module counter: the nonce must strictly increase across plays so a repeat
// fly-out to the same position still re-triggers the CSS animation.
let flourishSeq = 0;

export const useDetachAnimStore = create<DetachAnimStore>((set) => ({
  flourish: null,
  flyOut: (f) => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 0;
    const vh = typeof window !== "undefined" ? window.innerHeight : 0;
    // Clamp the origin inside the viewport: an out-of-window drop reports a
    // cursor past the edge, but the send-off must play where it's visible.
    const x = vw ? Math.max(16, Math.min(f.x, vw - 16)) : f.x;
    const y = vh ? Math.max(16, Math.min(f.y, vh - 16)) : f.y;
    set({
      flourish: {
        x,
        y,
        w: f.w,
        h: f.h,
        label: f.label,
        dx: f.dx ?? 0,
        dy: f.dy ?? 0,
        nonce: ++flourishSeq,
      },
    });
  },
  clear: (nonce) =>
    set((s) => (s.flourish?.nonce === nonce ? { flourish: null } : {})),
}));

/**
 * Compute the fly-out vector for a detach: a short push from the viewport centre
 * toward the exit point `(clientX, clientY)`, so the send-off slides in the
 * direction the new window appeared. Falls back to a gentle upward lift when the
 * exit point is at the centre (degenerate). Pure / unit-testable.
 */
export function flyVector(
  clientX: number,
  clientY: number,
  vw: number,
  vh: number,
  dist = 64,
): { dx: number; dy: number } {
  const cx = vw / 2;
  const cy = vh / 2;
  let vx = clientX - cx;
  let vy = clientY - cy;
  const len = Math.hypot(vx, vy);
  if (len < 1) return { dx: 0, dy: -dist }; // dead centre → lift upward
  vx /= len;
  vy /= len;
  return { dx: Math.round(vx * dist), dy: Math.round(vy * dist) };
}
