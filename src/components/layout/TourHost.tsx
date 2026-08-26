import { useEffect, useRef, useState } from "react";
import { useTourStore } from "../../stores/tour";
import { useProjectsStore } from "../../stores/projects";
import { nextEligibleIndex } from "../../lib/tour";
import { TourCoachmark } from "../common/TourCoachmark";
import { useT } from "../../lib/i18n";

// How long to wait for a step's anchor to appear before falling back to a
// centered card. Tour targets are persistent header/chrome that mount well
// before the tour can start, so this only guards genuinely-missing anchors and
// must never deadlock the walkthrough.
const ANCHOR_WAIT_MS = 600;

// How long to keep re-measuring after a step becomes active. Some anchors move
// under a CSS transition the moment the step opens them — the file panel slides
// in from the window edge — and a transform transition fires no ResizeObserver
// callback, so a single measure would freeze the spotlight mid-slide.
const SETTLE_MS = 700;

/** Union of every element the selector matches, or just the first when the step
 *  doesn't ask to span them. `spanAll` is for a step whose subject is a row of
 *  sibling controls; the default keeps a comma-separated anchor meaning "first
 *  of these that exists" (the panel-or-its-edge-marker fallback). */
function measureAnchor(selector: string, spanAll: boolean): DOMRect | null {
  if (!spanAll) {
    const el = document.querySelector(selector);
    return el ? el.getBoundingClientRect() : null;
  }
  const els = Array.from(document.querySelectorAll(selector));
  if (els.length === 0) return null;
  const rects = els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Two rects close enough to treat as the same position — the settle loop stops
 *  once a measurement repeats, so sub-pixel jitter must not keep it alive. */
function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * Drives the guided walkthroughs — the main tour, the advanced (remote) tour,
 * and the lessons: listens for the `eldrun:start-tour` /
 * `eldrun:start-advanced-tour` events, measures the active step's anchor (re-measuring as
 * the layout shifts), pulses the highlighted element, owns the keyboard
 * navigation, and renders the `TourCoachmark` overlay. Mounted once in
 * `AppShell` beside `HintHost` (never in detached windows). Selection/ordering
 * live in `lib/tour.ts`; persistence in `stores/tour.ts` — this component owns
 * only the impure DOM/timing concerns, mirroring `HintHost`.
 */
export function TourHost() {
  const t = useT();
  const active = useTourStore((s) => s.active);
  const index = useTourStore((s) => s.index);
  const steps = useTourStore((s) => s.steps);
  const start = useTourStore((s) => s.start);
  const startAdvanced = useTourStore((s) => s.startAdvanced);
  const next = useTourStore((s) => s.next);
  const prev = useTourStore((s) => s.prev);
  const skip = useTourStore((s) => s.skip);
  // Layout-affecting context: re-measure the anchor when these change.
  const projectCount = useProjectsStore((s) => s.projects.length);
  const activeId = useProjectsStore((s) => s.activeId);

  const [rect, setRect] = useState<DOMRect | null>(null);
  const gaveUp = useRef(false);

  const step = active ? steps[index] : null;

  // Entry points: the gear menu / Settings / HowToStart dispatch the first, the
  // gear menu and Settings the second (the first-run modal stays local-only).
  useEffect(() => {
    const onStart = () => start();
    const onStartAdvanced = () => startAdvanced();
    window.addEventListener("eldrun:start-tour", onStart);
    window.addEventListener("eldrun:start-advanced-tour", onStartAdvanced);
    return () => {
      window.removeEventListener("eldrun:start-tour", onStart);
      window.removeEventListener("eldrun:start-advanced-tour", onStartAdvanced);
    };
  }, [start, startAdvanced]);

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
    const spanAll = step.spanAll === true;
    let waitTimer = 0;
    let settleFrame = 0;
    let settleUntil = 0;
    let last: DOMRect | null = null;
    const measure = () => {
      const next = measureAnchor(selector, spanAll);
      if (next) {
        last = next;
        setRect(next);
      } else if (!gaveUp.current) {
        last = null;
        setRect(null);
      }
    };
    // Re-measure every frame until the rect stops moving (or the budget runs
    // out): a step that reveals the file panel is measuring a sliding target.
    const settle = () => {
      const before = last;
      measure();
      const stable = sameRect(before, last);
      if (!stable) settleUntil = performance.now() + SETTLE_MS;
      if (performance.now() < settleUntil) settleFrame = requestAnimationFrame(settle);
    };
    measure();
    settleUntil = performance.now() + SETTLE_MS;
    settleFrame = requestAnimationFrame(settle);
    // If the anchor isn't there yet, retry briefly, then give up to a banner.
    if (!document.querySelector(selector)) {
      waitTimer = window.setTimeout(() => {
        gaveUp.current = true;
        measure();
      }, ANCHOR_WAIT_MS);
    }
    const ro = new ResizeObserver(measure);
    for (const el of Array.from(document.querySelectorAll(selector))) {
      ro.observe(el);
      if (!spanAll) break;
    }
    window.addEventListener("resize", measure, true);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(waitTimer);
      cancelAnimationFrame(settleFrame);
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
    const els = step.spanAll
      ? Array.from(document.querySelectorAll(step.anchor))
      : [document.querySelector(step.anchor)].filter((e): e is Element => e != null);
    if (els.length === 0) return;
    for (const el of els) el.classList.add("hint-target");
    return () => {
      for (const el of els) el.classList.remove("hint-target");
    };
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
      title={t(step.titleKey)}
      body={t(step.bodyKey, step.bodyParams?.(t))}
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
