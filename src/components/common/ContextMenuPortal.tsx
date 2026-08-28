import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClampToViewport } from "../../hooks/useClampToViewport";

/**
 * The one context-menu/popover portal. Every right-click menu and click-opened
 * popover that portals to <body> renders through this instead of hand-rolling
 * the pattern, because the hand-rolled copies drifted: no viewport clamping
 * (menus opened near an edge rendered off-screen), inconsistent z-indexes
 * (one sat *below* the modal backdrop), and catchers that missed the
 * second-right-click case (a native menu stacked on top of the open one).
 *
 * What it provides:
 * - a full-viewport dismiss catcher that closes on any pointer-down AND on a
 *   right-click (preventDefault, so no native menu stacks on top);
 * - viewport clamping via useClampToViewport — the same hook the in-flow
 *   siblings (FileTree, TabBar, PageStrip) use;
 * - class-level layering (`.context-menu-catcher` / `.context-menu-portal`,
 *   `--z-menu*` tokens in themes.css) — call sites pass NO z-index.
 *
 * `className` styles the menu chrome (default `context-menu`); the portal
 * always adds `context-menu-portal`, which owns position:fixed + z-index and
 * wins over a chrome class's own positioning (e.g. `.tab-new-menu`).
 */
export function ContextMenuPortal({
  x,
  y,
  onClose,
  className = "context-menu",
  style,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>({ x, y });
  // Re-seed when the caller moves the anchor (a second right-click elsewhere
  // while the menu is open re-opens it at the new point).
  useLayoutEffect(() => {
    setPos({ x, y });
  }, [x, y]);
  useClampToViewport(ref, pos, setPos);
  const left = pos?.x ?? x;
  const top = pos?.y ?? y;
  return createPortal(
    <>
      <div
        className="context-menu-catcher"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className={`${className} context-menu-portal`}
        style={{ left, top, ...style }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
