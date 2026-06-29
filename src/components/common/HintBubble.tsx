import { createPortal } from "react-dom";

/**
 * A small floating coachmark anchored above/below a UI element, or a centered
 * top banner when `rect` is null. Portaled to `document.body` so it escapes the
 * right panel's `transform`/`overflow` stacking context (generalizes the
 * `LinkOpenHint` primitive in FileViewerPane, but interactive — it has buttons,
 * so no `pointer-events: none`). Positioning is computed by the caller (HintHost)
 * and passed in as `rect`; this component only paints.
 */
export function HintBubble({
  rect,
  placement,
  title,
  body,
  onDismiss,
  onDisableAll,
}: {
  rect: DOMRect | null;
  placement: "top" | "bottom";
  title: string;
  body: string;
  onDismiss: () => void;
  onDisableAll: () => void;
}) {
  const BUBBLE_W = 280;
  let style: React.CSSProperties;
  let banner = false;
  if (rect) {
    // Clamp horizontally so an edge-anchored hint never overflows off-screen.
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - BUBBLE_W - 8));
    style =
      placement === "top"
        ? { left, top: rect.top - 8, transform: "translateY(-100%)" }
        : { left, top: rect.bottom + 8 };
  } else {
    banner = true;
    style = {};
  }

  return createPortal(
    <div
      className={`hint-bubble${banner ? " hint-bubble--banner" : ""}`}
      role="dialog"
      aria-label={title}
      style={{ ...style, width: banner ? undefined : BUBBLE_W }}
    >
      <button
        type="button"
        className="hint-bubble-close"
        aria-label="Dismiss hint"
        onClick={onDismiss}
      >
        ×
      </button>
      <div className="hint-bubble-title">{title}</div>
      <div className="hint-bubble-body">{body}</div>
      <div className="hint-bubble-actions">
        <button type="button" className="hint-bubble-link" onClick={onDisableAll}>
          Don't show hints
        </button>
        <button type="button" className="hint-bubble-got-it" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}
