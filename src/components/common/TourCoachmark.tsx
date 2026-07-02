import { createPortal } from "react-dom";
import type { TourPlacement } from "../../lib/tour";

const BUBBLE_W = 300;
/** Padding around the spotlight cutout so the highlighted control isn't flush
 *  against the dim edge. */
const SPOT_PAD = 8;
/** Gap between the cutout and the bubble. */
const GAP = 12;

/** Bubble position for an anchored step, clamped to stay on-screen. The dim is
 *  produced by the spotlight element's huge box-shadow, so this only places the
 *  text bubble relative to the (already-padded) target rect. */
function bubbleStyle(rect: DOMRect, placement: TourPlacement): React.CSSProperties {
  const vw = window.innerWidth;
  const clampX = (x: number) => Math.max(8, Math.min(x, vw - BUBBLE_W - 8));
  switch (placement) {
    case "top":
      return { left: clampX(rect.left), top: rect.top - SPOT_PAD - GAP, transform: "translateY(-100%)" };
    case "left":
      return { left: Math.max(8, rect.left - SPOT_PAD - GAP), top: rect.top, transform: "translateX(-100%)" };
    case "right":
      return { left: clampX(rect.right + SPOT_PAD + GAP), top: rect.top };
    case "bottom":
    default:
      return { left: clampX(rect.left), top: rect.bottom + SPOT_PAD + GAP };
  }
}

/**
 * The guided-tour overlay for a single step: a full-screen click-blocker, a
 * spotlight cutout around the target (its box-shadow dims everything else), and
 * a navigation bubble with Back / Next / Skip. Narrated, not interactive — the
 * blocker swallows clicks so the user advances with Next, never by operating the
 * real control (which would open dialogs over the coachmark). Portaled to
 * `document.body` to escape the right panel's transform/overflow stacking, the
 * same trick `HintBubble` uses. When `rect` is null (target absent / intro), it
 * renders as a centered card over a plain dim instead.
 */
export function TourCoachmark({
  rect,
  placement,
  title,
  body,
  stepNumber,
  stepTotal,
  isFirst,
  isLast,
  onBack,
  onNext,
  onSkip,
}: {
  rect: DOMRect | null;
  placement: TourPlacement;
  title: string;
  body: string;
  stepNumber: number;
  stepTotal: number;
  isFirst: boolean;
  isLast: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const banner = !rect;
  const bubble = rect ? bubbleStyle(rect, placement) : {};

  return createPortal(
    <div className="tour-overlay">
      {/* Click-blocker: transparent, captures every pointer event so the tour is
          can't-get-lost. The spotlight/bubble sit above it and stay live. */}
      <div
        className="tour-blocker"
        onMouseDown={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      />
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            left: rect.left - SPOT_PAD,
            top: rect.top - SPOT_PAD,
            width: rect.width + SPOT_PAD * 2,
            height: rect.height + SPOT_PAD * 2,
          }}
        />
      )}
      <div
        className={`tour-bubble${banner ? " tour-bubble--banner" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ...bubble, width: banner ? undefined : BUBBLE_W }}
      >
        <div className="tour-bubble-title">{title}</div>
        <div className="tour-bubble-body">{body}</div>
        <div className="tour-bubble-footer">
          <span className="tour-bubble-count">
            {stepNumber} / {stepTotal}
          </span>
          <button type="button" className="tour-bubble-skip" onClick={onSkip}>
            Skip tour
          </button>
          <button
            type="button"
            className="tour-bubble-back"
            onClick={onBack}
            disabled={isFirst}
          >
            Back
          </button>
          <button type="button" className="tour-bubble-next" onClick={onNext}>
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
