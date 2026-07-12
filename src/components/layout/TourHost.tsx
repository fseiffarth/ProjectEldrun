import { useEffect, useRef, useState } from "react";
import { useTourStore } from "../../stores/tour";
import { useProjectsStore } from "../../stores/projects";
import { nextEligibleIndex } from "../../lib/tour";
import { TourCoachmark } from "../common/TourCoachmark";

// How long to wait for a step's anchor to appear before falling back to a
// centered card. Tour targets are persistent header/chrome that mount well
// before the tour can start, so this only guards genuinely-missing anchors and
// must never deadlock the walkthrough.
const ANCHOR_WAIT_MS = 600;

/**
 * Drives the guided "Take a tour" walkthrough: listens for the
 * `eldrun:start-tour` event, measures the active step's anchor (re-measuring as
 * the layout shifts), pulses the highlighted element, owns the keyboard
 * navigation, and renders the `TourCoachmark` overlay. Mounted once in
 * `AppShell` beside `HintHost` (never in detached windows). Selection/ordering
 * live in `lib/tour.ts`; persistence in `stores/tour.ts` — this component owns
 * only the impure DOM/timing concerns, mirroring `HintHost`.
 */
export function TourHost() {
  const active = useTourStore((s) => s.active);
  const index = useTourStore((s) => s.index);
  const steps = useTourStore((s) => s.steps);
  const start = useTourStore((s) => s.start);
  const next = useTourStore((s) => s.next);
  const prev = useTourStore((s) => s.prev);
  const skip = useTourStore((s) => s.skip);
  // Layout-affecting context: re-measure the anchor when these change.
  const projectCount = useProjectsStore((s) => s.projects.length);
  const activeId = useProjectsStore((s) => s.activeId);

  const [rect, setRect] = useState<DOMRect | null>(null);
  const gaveUp = useRef(false);

  const step = active ? steps[index] : null;

  // Entry point: the gear menu / Settings / HowToStart all dispatch this.
  useEffect(() => {
    const onStart = () => start();
    window.addEventListener("eldrun:start-tour", onStart);
    return () => window.removeEventListener("eldrun:start-tour", onStart);
  }, [start]);

  // Run a step's optional prepare side-effect (e.g. reveal the file panel so
  // the step has an anchor to spotlight) when it becomes active.
  useEffect(() => {
    step?.prepare?.();
  }, [step]);

  // Measure the active step's anchor and keep it positioned as the window/layout
  // shifts. A missing anchor falls back (after a bounded wait) to the centered
  // card so the tour can't stall on chrome that never appears.
  useEffect(() => {
    if (!step) {
      setRect(null);
      return;
    }
    if (!step.anchor) {
      setRect(null);
      return;
    }
    gaveUp.current = false;
    const selector = step.anchor;
    let waitTimer = 0;
    const measure = () => {
      const el = document.querySelector(selector);
      if (el) {
        setRect(el.getBoundingClientRect());
      } else if (!gaveUp.current) {
        setRect(null);
      }
    };
    measure();
    // If the anchor isn't there yet, retry briefly, then give up to a banner.
    if (!document.querySelector(selector)) {
      waitTimer = window.setTimeout(() => {
        gaveUp.current = true;
        measure();
      }, ANCHOR_WAIT_MS);
    }
    const ro = new ResizeObserver(measure);
    const el = document.querySelector(selector);
    if (el) ro.observe(el);
    window.addEventListener("resize", measure, true);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(waitTimer);
      ro.disconnect();
      window.removeEventListener("resize", measure, true);
      window.removeEventListener("scroll", measure, true);
    };
    // projectCount/activeId are deps so the anchor re-resolves after a layout
    // shift (e.g. a project opening adds the tab bar the step points at).
  }, [step, projectCount, activeId]);

  // Pulse the highlighted element while its step is on screen (reuses the
  // contextual-hint `.hint-target` glow), cleaned up on step change/teardown.
  useEffect(() => {
    if (!step?.anchor) return;
    const el = document.querySelector(step.anchor);
    if (!el) return;
    el.classList.add("hint-target");
    return () => el.classList.remove("hint-target");
  }, [step, projectCount, activeId]);

  // Keyboard navigation while the tour runs: Esc skips, ←/→ and Enter step.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, skip, next, prev]);

  if (!step) return null;

  const ctx = { projectCount, activeId };
  const isLast = nextEligibleIndex(steps, ctx, index + 1) >= steps.length;
  // Human-readable position: count eligible steps up to and including this one.
  const eligible = steps.filter((s) => (s.when ? s.when(ctx) : true));
  const stepTotal = eligible.length;
  const stepNumber = eligible.findIndex((s) => s.id === step.id) + 1;
  const isFirst = stepNumber <= 1;

  return (
    <TourCoachmark
      rect={rect}
      placement={step.placement}
      title={step.title}
      body={step.body}
      stepNumber={stepNumber}
      stepTotal={stepTotal}
      isFirst={isFirst}
      isLast={isLast}
      onBack={prev}
      onNext={next}
      onSkip={skip}
    />
  );
}
