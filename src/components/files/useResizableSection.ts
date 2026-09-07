import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag-to-resize height for a side-panel section (Downloads, Alerts): grab
 * the top handle to grow the section into the panel above, clamped to the
 * panel's height. Shared so every section that wants this grows the same way.
 */
export function useResizableSection(defaultHeightPx: number) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [heightPx, setHeightPx] = useState(defaultHeightPx);

  function onResizePointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = sectionRef.current?.offsetHeight ?? heightPx;
    const parentH =
      sectionRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY; // drag up = taller
      // Leave room for the tree above; never smaller than a couple of rows.
      const next = Math.max(80, Math.min(parentH - 120, startH + delta));
      setHeightPx(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return { sectionRef, heightPx, onResizePointerDown };
}
