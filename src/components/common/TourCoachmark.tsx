import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TourPlacement } from "../../lib/tour";
import { useT } from "../../lib/i18n";

const BUBBLE_W = 300;
/** Padding around the spotlight cutout so the highlighted control isn't flush
 *  against the dim edge. */
const SPOT_PAD = 8;
/** Gap between the cutout and the bubble. */
const GAP = 12;
/** Keep-clear margin between the bubble and the window edge. */
const EDGE = 8;

/**
 * Bubble position for an anchored step: the requested side when it fits, the
 * opposite side when it doesn't, clamped to the window either way. The flip is
 * load-bearing, not a nicety — the file panel docks to *either* edge
 * (`right_panel_side`), so the "find your files" steps point at a marker that
 * can sit at x=0, where a left-placed bubble would hang 300px off-screen.
 *
 * Positions are plain left/top with no negative transform: the bubble's real
 * box has to be what gets clamped, and a `translateX(-100%)` moves it after the
 * clamp has already had its say.
 *
 * The dim itself is the spotlight element's huge box-shadow, so this only
 * places the text bubble relative to the (already-padded) target rect.
 * `bubbleH` is the measured height (0 before the first measure, which only
 * costs one frame of a slightly-off vertical clamp).
 */
export function bubbleStyle(
  rect: DOMRect,
  placement: TourPlacement,
  bubbleH: number,
): React.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, vw - BUBBLE_W - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, vh - bubbleH - EDGE));
  // The spotlight's padded box is what the bubble sits beside.
  const spot = {
    left: rect.left - SPOT_PAD,
    right: rect.right + SPOT_PAD,
    top: rect.top - SPOT_PAD,
    bottom: rect.bottom + SPOT_PAD,
  };
  const fits = {
    left: spot.left - GAP - BUBBLE_W >= EDGE,
    right: spot.right + GAP + BUBBLE_W <= vw - EDGE,
    top: spot.top - GAP - bubbleH >= EDGE,
    bottom: spot.bottom + GAP + bubbleH <= vh - EDGE,
  };
  const opposite: Record<TourPlacement, TourPlacement> = {
    left: "right",
    right: "left",
    top: "bottom",
    bottom: "top",
  };
  // Flip only when the requested side has no room and the other one does;
  // otherwise keep the authored placement and let the clamp handle it.
  const side =
    !fits[placement] && fits[opposite[placement]] ? opposite[placement] : placement;
  switch (side) {
    case "top":
      return { left: clampX(spot.left), top: clampY(spot.top - GAP - bubbleH) };
    case "left":
      return { left: clampX(spot.left - GAP - BUBBLE_W), top: clampY(rect.top) };
    case "right":
      return { left: clampX(spot.right + GAP), top: clampY(rect.top) };
    case "bottom":
    default:
      return { left: clampX(spot.left), top: clampY(spot.bottom + GAP) };
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
  const t = useT();
  const banner = !rect;
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  // Measured so the vertical clamp/flip works on the real bubble instead of a
  // guess — step copy varies enough in length to matter near the window edges.
  const [bubbleH, setBubbleH] = useState(0);
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const measure = () => setBubbleH(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [title, body, banner]);
  const bubble = rect ? bubbleStyle(rect, placement, bubbleH) : {};

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
        ref={bubbleRef}
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
            {t("tour.skip")}
          </button>
          <button
            type="button"
            className="tour-bubble-back"
            onClick={onBack}
            disabled={isFirst}
          >
            {t("tour.back")}
          </button>
          <button type="button" className="tour-bubble-next" onClick={onNext}>
            {isLast ? t("tour.done") : t("tour.next")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
