/**
 * The two things a *presented* deck paints: a slide letterboxed to its host, and
 * the GIF that plays between two slides.
 *
 * They live here rather than inside `DeckPresenter` because the dual-window
 * presenter renders them in **two** webviews — the audience window on the
 * projector and the presenter window's own preview — and the one thing the
 * audience must never see is the two displays disagreeing about what a slide
 * looks like. One component, rendered twice, cannot drift.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { type Slide, visibleAt } from "../../../lib/viewers/deck/model";
import type { TextMetrics } from "../../../lib/viewers/deck/fonts";
import { DeckObjectView } from "./DeckObjectView";
import { renderPage } from "./deckBase";
import { type DecodedGif, playGif } from "./gifPlayback";

export interface PresentedSlideProps {
  slide: Slide;
  step: number;
  doc: PDFDocumentProxy | null;
  pageWidth: number;
  pageHeight: number;
  metrics: TextMetrics | null;
  assets: ReadonlyMap<string, string>;
  transition: string;
  /** Suppresses build entrances — a *preview* of the next slide should not
   *  animate every time the speaker steps a build on the current one. */
  still?: boolean;
}

/** One slide, letterboxed to its host, with only the objects built so far. */
export function PresentedSlide({
  slide,
  step,
  doc,
  pageWidth,
  pageHeight,
  metrics,
  assets,
  transition,
  still = false,
}: PresentedSlideProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => {
      const aspect = pageWidth / pageHeight;
      let w = host.clientWidth;
      let h = w / aspect;
      if (h > host.clientHeight) {
        h = host.clientHeight;
        w = h * aspect;
      }
      setSize((p) => (Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5 ? p : { w, h }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [pageWidth, pageHeight]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc || size.w <= 0) return;
    return renderPage(doc, slide.anchor.page, canvas, size.w, size.h);
  }, [doc, slide.anchor.page, size.w, size.h]);

  const pointScale = size.w > 0 && pageWidth > 0 ? size.w / pageWidth : 1;

  return (
    <div className="deck-presenter-fit" ref={hostRef}>
      <div
        className={`deck-presenter-page${
          !still && transition && transition !== "none" ? ` deck-trans-${transition}` : ""
        }`}
        style={{ width: size.w, height: size.h }}
      >
        <canvas className="deck-stage-canvas" ref={canvasRef} />
        {slide.objects.filter((o) => visibleAt(o, step)).map((o) => (
          <div
            key={o.id}
            // Re-keying on the step is what makes the entrance animation replay
            // when an object is revealed, rather than only on first mount.
            className={
              !still && o.build && o.build.step === step && o.build.effect !== "none"
                ? `deck-build deck-build-${o.build.effect}`
                : undefined
            }
          >
            <DeckObjectView
              obj={o}
              pageW={size.w}
              pageH={size.h}
              pointScale={pointScale}
              assetUrl={o.kind === "image" ? assets.get(o.src) : undefined}
              metrics={metrics}
              selected={false}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface InterstitialViewProps {
  gif: DecodedGif | undefined;
  fit: "contain" | "cover";
  background: string;
  advance: { on: "manual" } | { on: "end" } | { on: "end-after"; loops: number };
  onEnded: () => void;
}

/** The GIF that plays between two slides. */
export function InterstitialView({
  gif,
  fit,
  background,
  advance,
  onEnded,
}: InterstitialViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gif) return;
    // `manual` loops until the speaker advances — the right default for a clip
    // you talk over. The others stop themselves and hand the stop on.
    const loops = advance.on === "end" ? 1 : advance.on === "end-after" ? advance.loops : Infinity;
    let seen = 0;
    return playGif(canvas, gif, {
      fit,
      background,
      loop: loops > 1,
      onEnded: () => {
        seen += 1;
        if (seen >= loops) endedRef.current();
      },
    });
  }, [gif, fit, background, advance]);

  if (!gif) {
    return (
      <div className="deck-presenter-fit deck-presenter-loading" style={{ background }}>
        Loading animation…
      </div>
    );
  }
  return <canvas className="deck-presenter-gif" ref={canvasRef} />;
}
