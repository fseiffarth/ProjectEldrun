/**
 * The **audience** window of the dual-window presenter: the OS window that goes
 * on the projector while the speaker keeps the notes/timer view on the laptop.
 *
 * It is deliberately the *dumb* half. It owns no navigation state — the stop and
 * the blank screen arrive from the presenter window and are rendered as given —
 * because two indices for one talk is exactly how the two displays end up a
 * slide apart in front of a room. Keys pressed here (the speaker may well have
 * focus on this window, or be using a clicker bound to it) are forwarded as
 * *requests* and come back as state.
 *
 * It loads its own heavy assets — base PDF, images, GIF frames — from the deck's
 * path over the ordinary confined file commands, so nothing large ever crosses
 * as an event payload. The deck itself does arrive as its serialized sidecar,
 * because the presenter window may hold edits not yet autosaved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  useSettingsStore,
  applyTheme,
  THEME_CHANGED_EVENT,
} from "../../../stores/settings";
import {
  type NavAction,
  type PresentSeed,
  type PresentState,
  PRESENT_CLOSED,
  PRESENT_NAV,
  PRESENT_READY,
  keyToAction,
  presentSeedEvent,
  presentStateEvent,
} from "../../../lib/viewers/deck/present";
import { type Deck, type Slide, type Stop, sequence } from "../../../lib/viewers/deck/model";
import { parseDeck, pdfPathForDeck } from "../../../lib/viewers/deck/sidecar";
import { type TextMetrics, loadMetrics } from "../../../lib/viewers/deck/fonts";
import { loadBase } from "./deckBase";
import { dirOf, interstitialsOf, resolveRel, useDeckGifs, useDeckImages } from "./deckAssets";
import { InterstitialView, PresentedSlide } from "./DeckSlideView";

/** How often to re-announce readiness until a seed lands. The presenter window
 *  may still be mounting its listener when this window first asks. */
const READY_RETRY_MS = 400;

export interface DeckAudienceAppProps {
  /** This window's Tauri label, from `?present=` — the seed/state channels' namespace. */
  label: string;
}

export function DeckAudienceApp({ label }: DeckAudienceAppProps) {
  const loadSettings = useSettingsStore((s) => s.load);

  const [seed, setSeed] = useState<PresentSeed | null>(null);
  const [state, setState] = useState<PresentState>({ index: 0, blank: null });
  const [deck, setDeck] = useState<Deck | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);

  // Theme: this window is its own JS runtime with its own settings store, so it
  // loads them itself and follows the main window's live theme broadcast — the
  // same bargain `DetachedApp` strikes. Zoom is deliberately NOT applied: a
  // projector surface is sized by the slide, not by the editor's zoom.
  useEffect(() => {
    void loadSettings({ skipZoom: true });
  }, [loadSettings]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(THEME_CHANGED_EVENT, (e) => applyTheme(e.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let live = true;
    void loadMetrics().then((m) => {
      if (live) setMetrics(m);
    });
    return () => {
      live = false;
    };
  }, []);

  // --- the link ------------------------------------------------------------

  const seededRef = useRef(false);

  useEffect(() => {
    let unlistenSeed: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let cancelled = false;

    void listen<PresentSeed>(presentSeedEvent(label), (e) => {
      seededRef.current = true;
      setSeed(e.payload);
      setState({ index: e.payload.index, blank: e.payload.blank });
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenSeed = fn;
    });

    void listen<PresentState>(presentStateEvent(label), (e) => setState(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlistenState = fn;
    });

    // Ask, and keep asking until answered: this window and the presenter's
    // listener race on open, and a dropped first request would leave a black
    // projector with no way back.
    void emit(PRESENT_READY, { label });
    const t = setInterval(() => {
      if (seededRef.current) return;
      void emit(PRESENT_READY, { label });
    }, READY_RETRY_MS);

    return () => {
      cancelled = true;
      clearInterval(t);
      unlistenSeed?.();
      unlistenState?.();
    };
  }, [label]);

  // Tell the presenter window when this one is closed from the WM, so it drops
  // back to the single-display presenter instead of streaming at a dead window.
  // (A close driven from the presenter side `destroy()`s, which bypasses this —
  // it already knows.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested(() => {
        void emit(PRESENT_CLOSED, { label });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [label]);

  const send = useCallback(
    (action: NavAction) => {
      void emit(PRESENT_NAV, { label, action });
    },
    [label],
  );

  // --- deck + base plate ---------------------------------------------------

  useEffect(() => {
    if (!seed) return;
    const parsed = parseDeck(seed.deck);
    if (parsed.error) return;
    setDeck(parsed.deck);
  }, [seed]);

  useEffect(() => {
    if (!seed || !deck) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    const dir = dirOf(seed.path);
    const basePath = resolveRel(dir, deck.base ?? pdfPathForDeck(seed.path));
    void (async () => {
      try {
        const base = await loadBase(basePath, seed.scope);
        opened = base.doc;
      } catch {
        // No plate: the layers still present. The presenter window shows the
        // same deck and reports the problem there; a talk in progress should
        // not gain an error banner on the projector.
        return;
      }
      if (cancelled) {
        opened.destroy();
        return;
      }
      setDoc(opened);
    })();
    return () => {
      cancelled = true;
      opened?.destroy();
      setDoc(null);
    };
    // Re-anchoring is the presenter window's job; this one only needs the pages.
    // Keyed on the resolved base path so a re-seed with the same plate does not
    // tear down and re-open the document mid-talk.
  }, [seed?.path, seed?.scope, deck?.base]);

  const interstitials = useMemo(() => interstitialsOf(deck), [deck]);
  const { assets } = useDeckImages(deck, seed?.path ?? "", seed?.scope ?? null);
  const gifs = useDeckGifs(interstitials, seed?.path ?? "", seed?.scope ?? null);

  // --- keys ----------------------------------------------------------------

  const gotoRef = useRef("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (gotoRef.current) {
          send({ kind: "goto", slide: Number(gotoRef.current) - 1 });
          gotoRef.current = "";
        }
        return;
      }
      const action = keyToAction(e.key);
      if (!action) {
        gotoRef.current = "";
        return;
      }
      if (action.kind === "digit") {
        gotoRef.current = (gotoRef.current + action.digit).slice(-4);
        return;
      }
      e.preventDefault();
      send(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  // --- render --------------------------------------------------------------

  const stops = useMemo(() => (deck ? sequence(deck) : []), [deck]);
  const stop: Stop | undefined = stops[state.index];
  const slide: Slide | undefined = stop ? deck?.slides[stop.slide] : undefined;

  // The transition belongs to the slide being LEFT, and must be known during the
  // render that first shows the new one — a state write would land a frame late,
  // which is one frame of un-transitioned slide.
  const prevSlideRef = useRef<number | null>(null);
  const transitionRef = useRef<string>("none");
  if (deck && stop && prevSlideRef.current !== stop.slide) {
    const from = prevSlideRef.current;
    transitionRef.current =
      from != null && deck.slides[from] ? deck.slides[from].transition : "none";
    prevSlideRef.current = stop.slide;
  }

  if (!deck || !stop) {
    return (
      <div className="deck-presenter deck-audience">
        <div className="deck-presenter-main">
          <div className="deck-presenter-fit deck-presenter-loading">
            Waiting for the presentation…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="deck-presenter deck-audience">
      <div className="deck-presenter-main">
        <div className="presentation-host deck-presenter-stage">
          {stop.kind === "interstitial" && slide?.after ? (
            <InterstitialView
              gif={gifs.get(slide.after.id)}
              fit={slide.after.fit}
              background={slide.after.background}
              advance={slide.after.advance}
              onEnded={() => send({ kind: "next" })}
            />
          ) : (
            slide && (
              <PresentedSlide
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
        </div>
        {state.blank && <div className={`deck-presenter-blank is-${state.blank}`} />}
      </div>
    </div>
  );
}
