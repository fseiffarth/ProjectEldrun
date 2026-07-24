/**
 * The presenter.
 *
 * Navigation runs off `model.sequence(deck)`, which flattens the deck into an
 * ordered list of *stops* — a slide at a build step, or an interstitial. Doing
 * that up front is what makes the awkward cases correct by construction: `←`
 * steps a build backwards instead of jumping a slide (losing the slide to the
 * first audience question is the single most common presenter-software failure),
 * and a GIF that plays between two slides is simply one more stop.
 *
 * **One presenter, one or two screens.** With no second display this is the
 * fullscreen presenter with an optional notes/timer panel (`N`). Press `D` (or
 * the ⧉ button) and Eldrun opens an **audience window** — a separate OS window,
 * placed fullscreen on another monitor when there is one — and this window
 * becomes the *presenter view*: current slide, next slide, notes, timer, build
 * indicator. This window keeps owning the stop; the audience window renders what
 * it is told and forwards its own keys back (see `deck/present.ts`). Two heaps,
 * one index — the two displays cannot drift apart.
 *
 * The laser and marker are `PresentationOverlay`, mounted verbatim — it is
 * self-contained, stores nothing, and already solves normalized coordinates and
 * device-pixel sizing. It only needs a `position: relative` host. Known limit of
 * the dual-window mode: those strokes are drawn on *this* window and are not
 * mirrored to the audience one.
 *
 * Rendered through a portal into `#root` rather than `document.body`: a
 * body-level portal can fail to paint in a detached popout webview (documented at
 * `ContextFilePicker.tsx`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PresentationOverlay } from "../PresentationOverlay";
import {
  type Deck,
  type Slide,
  type Stop,
  sequence,
} from "../../../lib/viewers/deck/model";
import { serializeDeck } from "../../../lib/viewers/deck/sidecar";
import {
  type Blank,
  type PresentNav,
  type PresentReady,
  type PresentSeed,
  PRESENT_CLOSED,
  PRESENT_NAV,
  PRESENT_READY,
  applyNav,
  clampStop,
  keyToAction,
  presentSeedEvent,
  presentStateEvent,
  presenterLabel,
  slideStopIndex,
} from "../../../lib/viewers/deck/present";
import type { TextMetrics } from "../../../lib/viewers/deck/fonts";
import { type DecodedGif, disposeGif } from "./gifPlayback";
import { InterstitialView, PresentedSlide } from "./DeckSlideView";

export interface DeckPresenterProps {
  deck: Deck;
  doc: PDFDocumentProxy | null;
  metrics: TextMetrics | null;
  assets: ReadonlyMap<string, string>;
  /** Interstitial id → decoded clip, or `undefined` while it loads. */
  gifs: ReadonlyMap<string, DecodedGif>;
  /** The deck's sidecar path — names the audience window and locates its assets. */
  path: string;
  /** File scope the audience window reads its own bytes under. */
  scope: string | null;
  /** Stop to open on. */
  startAt?: number;
  onClose: () => void;
}

export function DeckPresenter({
  deck,
  doc,
  metrics,
  assets,
  gifs,
  path,
  scope,
  startAt = 0,
  onClose,
}: DeckPresenterProps) {
  const stops = useMemo(() => sequence(deck), [deck]);
  const [index, setIndex] = useState(() => Math.min(startAt, Math.max(0, stops.length - 1)));
  const [blank, setBlank] = useState<Blank>(null);
  const [grid, setGrid] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [goto, setGoto] = useState("");
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  /** The audience window's label while it is open, else null. */
  const [audience, setAudience] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const stop: Stop | undefined = stops[index];
  const slide: Slide | undefined = stop ? deck.slides[stop.slide] : undefined;

  // The transition is a property of the slide being LEFT ("leaving this slide"
  // in the animate panel), so it is read off the previous stop, not the new one.
  // Held in a ref rather than state: it must be known during the render that
  // first shows the new slide, and a state write would land one frame late —
  // which is exactly one frame of un-transitioned slide.
  const prevSlideRef = useRef<number | null>(null);
  const transitionRef = useRef<string>("none");
  if (stop && prevSlideRef.current !== stop.slide) {
    const from = prevSlideRef.current;
    transitionRef.current =
      from != null && deck.slides[from] ? deck.slides[from].transition : "none";
    prevSlideRef.current = stop.slide;
  }

  // A one-second tick for the elapsed clock. Cheap, and the presenter is the one
  // place a wall clock genuinely earns its re-render.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const next = useCallback(() => setIndex((i) => clampStop(stops, i + 1)), [stops]);
  const prev = useCallback(() => setIndex((i) => clampStop(stops, i - 1)), [stops]);

  const jumpToSlide = useCallback(
    (n: number) => {
      const found = slideStopIndex(stops, n);
      if (found >= 0) setIndex(found);
      setGrid(false);
    },
    [stops],
  );

  // --- the audience window -------------------------------------------------

  const label = useMemo(() => presenterLabel(path), [path]);

  const openAudience = useCallback(async () => {
    setLinkError(null);
    try {
      await invoke("open_presenter_window", { label });
      setAudience(label);
    } catch (e) {
      setLinkError(
        `The second display could not be opened (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }, [label]);

  const closeAudience = useCallback(() => {
    setAudience(null);
    void invoke("close_presenter_window", { label }).catch(() => {
      // A window already gone is the state we wanted.
    });
  }, [label]);

  // Closing the talk takes the audience window with it — a slide left glowing on
  // a projector after the speaker has sat down is worse than no second display.
  const closeAll = useCallback(() => {
    if (audience) closeAudience();
    onClose();
  }, [audience, closeAudience, onClose]);

  // Where we are, for a seed. Read through refs so seeding does NOT depend on
  // the index: it does, of course, carry it, but a dependency would re-serialize
  // the whole deck on every keypress of the talk.
  const whereRef = useRef({ index, blank });
  whereRef.current = { index, blank };

  const seed = useCallback(() => {
    if (!audience) return;
    const payload: PresentSeed = {
      path,
      scope,
      // Serialized, not the live object: the audience window parses the sidecar
      // form, which is the only shape both halves agree on — and this window may
      // hold edits the 800 ms autosave has not written yet.
      deck: serializeDeck(deck),
      index: whereRef.current.index,
      blank: whereRef.current.blank,
    };
    void emit(presentSeedEvent(audience), payload);
  }, [audience, deck, path, scope]);

  // Seed on request (the audience window asks until answered) and whenever the
  // deck itself changes under an open window.
  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PresentReady>(PRESENT_READY, (e) => {
      if (e.payload.label === audience) seed();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience, seed]);

  useEffect(() => {
    seed();
  }, [seed]);

  // Stream the stop/blank. Small and frequent — the seed carries the deck, this
  // carries only where we are in it.
  useEffect(() => {
    if (!audience) return;
    void emit(presentStateEvent(audience), { index, blank });
  }, [audience, index, blank]);

  // Keys pressed on the audience window arrive as requests; this window remains
  // the only place the index actually moves.
  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PresentNav>(PRESENT_NAV, (e) => {
      if (e.payload.label !== audience) return;
      const action = e.payload.action;
      if (action.kind === "close") {
        closeAll();
        return;
      }
      if (action.kind === "blank") {
        setBlank((v) => (v === action.mode ? null : action.mode));
        return;
      }
      setIndex((i) => applyNav(stops, i, action));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience, stops, closeAll]);

  // The audience window was closed from the WM: drop back to one screen rather
  // than streaming at a window that is not there.
  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ label: string }>(PRESENT_CLOSED, (e) => {
      if (e.payload.label === audience) setAudience(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience]);

  // Unmount (the tab closed, the deck reloaded) must not leave an orphaned
  // window on the projector. Read through a ref so this fires exactly once, at
  // teardown, instead of on every toggle.
  const audienceRef = useRef<string | null>(null);
  audienceRef.current = audience;
  useEffect(
    () => () => {
      if (audienceRef.current) {
        void invoke("close_presenter_window", { label: audienceRef.current }).catch(() => {});
      }
    },
    [],
  );

  // --- keys ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys this window owns alone: the overlays and the second display are
      // the speaker's, not the audience's.
      switch (e.key) {
        case "Enter":
          if (goto) {
            jumpToSlide(Number(goto) - 1);
            setGoto("");
          }
          return;
        case "g":
        case "G":
          setGrid((v) => !v);
          return;
        case "n":
        case "N":
          setNotesOpen((v) => !v);
          return;
        case "d":
        case "D":
          if (audience) closeAudience();
          else void openAudience();
          return;
        case "Escape":
          // Escape peels one layer at a time rather than dumping you out of the
          // talk from whatever overlay happens to be open.
          if (grid) setGrid(false);
          else if (blank) setBlank(null);
          else closeAll();
          return;
        default:
          break;
      }

      // Everything else goes through the SAME mapping the audience window uses,
      // so whichever display has focus, a key means the same thing.
      const action = keyToAction(e.key);
      if (!action) {
        setGoto("");
        return;
      }
      if (action.kind === "digit") {
        setGoto((g) => (g + action.digit).slice(-4));
        return;
      }
      if (action.kind === "close") {
        closeAll();
        return;
      }
      if (action.kind === "blank") {
        setBlank((v) => (v === action.mode ? null : action.mode));
        return;
      }
      e.preventDefault();
      // A blanked screen swallows the first advance: the key that wakes the
      // screen should not also move the talk on.
      if (blank && (action.kind === "next" || action.kind === "prev")) {
        setBlank(null);
        return;
      }
      setIndex((i) => applyNav(stops, i, action));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    stops,
    blank,
    grid,
    goto,
    jumpToSlide,
    closeAll,
    audience,
    openAudience,
    closeAudience,
  ]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const root = typeof document !== "undefined" ? document.getElementById("root") : null;
  if (!root || !stop) return null;

  const elapsed = Math.floor((now - started) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const wall = new Date(now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const nextSlideIndex = stops.slice(index + 1).find((s) => s.kind === "slide")?.slide;
  const nextSlide = nextSlideIndex !== undefined ? deck.slides[nextSlideIndex] : undefined;
  // With the audience on its own screen this window IS the presenter view, so
  // the notes column stops being optional — hiding it would leave the speaker
  // looking at a second copy of what the room already sees.
  const showNotes = notesOpen || audience !== null;
  const builds = stop.kind === "slide" ? stop.step : 0;

  return createPortal(
    <div
      className={`deck-presenter${audience ? " is-dual" : ""}`}
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="deck-presenter-main">
        {/* PresentationOverlay needs a position:relative host; giving it the
            slide area (not the whole window) keeps marker strokes anchored to
            the slide rather than to the chrome around it. */}
        <div className="presentation-host deck-presenter-stage">
          {stop.kind === "interstitial" && slide?.after ? (
            <InterstitialView
              gif={gifs.get(slide.after.id)}
              fit={slide.after.fit}
              background={slide.after.background}
              advance={slide.after.advance}
              onEnded={next}
            />
          ) : (
            slide && (
              <PresentedSlide
                // Re-keying on the slide is what makes the entrance transition
                // replay: a CSS animation on a persistent element only runs once.
                key={slide.id}
                slide={slide}
                step={stop.kind === "slide" ? stop.step : 0}
                doc={doc}
                pageWidth={deck.pageWidth}
                pageHeight={deck.pageHeight}
                metrics={metrics}
                assets={assets}
                transition={transitionRef.current}
              />
            )
          )}
          <PresentationOverlay />
        </div>

        {blank && <div className={`deck-presenter-blank is-${blank}`} />}

        {grid && (
          <div className="deck-presenter-grid" role="listbox" aria-label="All slides">
            {deck.slides.map((s, i) => (
              <button
                key={s.id}
                className={`deck-presenter-grid-cell${i === stop.slide ? " active" : ""}`}
                onClick={() => jumpToSlide(i)}
              >
                <span className="deck-presenter-grid-num">{i + 1}</span>
                {s.notes.trim() && <span className="deck-presenter-grid-note" title={s.notes} />}
              </button>
            ))}
          </div>
        )}

        {goto && <div className="deck-presenter-goto">Go to slide {goto}…</div>}
      </div>

      {showNotes && (
        <aside className="deck-presenter-notes">
          <div className="deck-presenter-notes-head">
            <span>
              Slide {stop.slide + 1} / {deck.slides.length}
              {stop.kind === "slide" && stop.step > 0 && ` · build ${builds}`}
              {stop.kind === "interstitial" && " · animation"}
            </span>
            <span className="deck-presenter-timer" title={`Started at ${new Date(started).toLocaleTimeString()}`}>
              {mm}:{ss}
            </span>
          </div>

          {audience && (
            <div className="deck-presenter-audience-note">
              Audience view is on the second display. <kbd>D</kbd> closes it.
            </div>
          )}
          {linkError && <div className="deck-presenter-audience-note is-error">{linkError}</div>}

          {/* The next slide, still: a preview that re-ran its build entrances
              every time the speaker stepped one on the CURRENT slide would be a
              flicker in the corner of their eye for the whole talk. */}
          {nextSlide && (
            <div className="deck-presenter-next-preview">
              <span className="deck-presenter-next-label">Next · slide {(nextSlideIndex ?? 0) + 1}</span>
              <div className="deck-presenter-next-frame">
                <PresentedSlide
                  key={`next-${nextSlide.id}`}
                  slide={nextSlide}
                  step={Number.MAX_SAFE_INTEGER}
                  doc={doc}
                  pageWidth={deck.pageWidth}
                  pageHeight={deck.pageHeight}
                  metrics={metrics}
                  assets={assets}
                  transition="none"
                  still
                />
              </div>
            </div>
          )}

          <div className="deck-presenter-notes-body">
            {slide?.notes.trim() ? slide.notes : <em>No notes for this slide.</em>}
          </div>

          <div className="deck-presenter-next">
            {nextSlideIndex !== undefined ? (
              <>
                Next: slide {nextSlideIndex + 1}
                {deck.slides[nextSlideIndex]?.after && " (animation follows)"}
              </>
            ) : (
              "Last slide."
            )}
            <span className="deck-presenter-wall">{wall}</span>
          </div>
        </aside>
      )}

      <div className="deck-presenter-bar">
        <button onClick={prev} title="Previous (←)" aria-label="Previous">
          ‹
        </button>
        <span className="deck-presenter-pos">
          {stop.slide + 1} / {deck.slides.length}
        </span>
        <button onClick={next} title="Next (Space / →)" aria-label="Next">
          ›
        </button>
        <button
          className={notesOpen ? "active" : ""}
          onClick={() => setNotesOpen((v) => !v)}
          title="Speaker notes (N)"
        >
          ☰
        </button>
        <button className={grid ? "active" : ""} onClick={() => setGrid((v) => !v)} title="Overview (G)">
          ⊞
        </button>
        <button
          className={audience ? "active" : ""}
          onClick={() => (audience ? closeAudience() : void openAudience())}
          title="Audience view on a second display (D)"
          aria-label="Second display"
        >
          ⧉
        </button>
        <button onClick={closeAll} title="Exit (Esc)" aria-label="Exit">
          ✕
        </button>
      </div>
    </div>,
    root,
  );
}

export { disposeGif };
