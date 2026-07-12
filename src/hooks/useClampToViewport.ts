import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps a fixed-position popup (context menu, dropdown) inside the viewport.
 * Popups are positioned at a cursor/anchor point and grow right/down, so one
 * opened near the window's right or bottom edge clips off-screen. Measures
 * the rendered element once mounted and shifts it back in. Guarded so the
 * corrective set doesn't loop (it re-runs, finds nothing to fix, stops).
 */
export function useClampToViewport<T extends { x: number; y: number }>(
  ref: RefObject<HTMLElement | null>,
  pos: T | null,
  setPos: (updater: (p: T | null) => T | null) => void,
  margin = 8,
) {
  useLayoutEffect(() => {
    if (!pos) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = pos.x;
    let ny = pos.y;
    if (rect.right > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (rect.bottom > window.innerHeight - margin) {
      ny = Math.max(margin, window.innerHeight - margin - rect.height);
    }
    if (nx !== pos.x || ny !== pos.y) {
      setPos((p) => (p ? { ...p, x: nx, y: ny } : p));
    }
  }, [pos, ref, setPos, margin]);
}
