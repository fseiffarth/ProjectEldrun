/**
 * Loading a deck's *heavy* parts — placed images and interstitial GIFs.
 *
 * Extracted from `DeckView` when the dual-window presenter landed: the audience
 * window is a separate webview with its own heap, so it cannot be handed the
 * editor's blob URLs or decoded frames — it must load them itself. Two copies of
 * this would be two chances to leak, since both halves own resources the GC
 * cannot reclaim (an object URL and an `ImageBitmap`), so there is one.
 *
 * Both hooks own their resources for the lifetime of the mount and release what
 * leaves the deck as it leaves, plus everything at unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileBytes } from "../fileAccess";
import type { Deck, Interstitial } from "../../../lib/viewers/deck/model";
import { type DecodedGif, decodeInterstitial, disposeGif } from "./gifPlayback";

/** The directory part of a path, `""` for a bare filename. */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

/** Resolve a deck-relative asset path against the sidecar's own directory. */
export function resolveRel(dir: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel;
  return dir ? `${dir}/${rel}` : rel;
}

/** Every interstitial in the deck, in slide order. */
export function interstitialsOf(deck: Deck | null): Interstitial[] {
  return (deck?.slides ?? [])
    .map((s) => s.after)
    .filter((a): a is Interstitial => a != null);
}

/**
 * Blob URLs for every image object's bytes, keyed by the deck-relative `src`.
 *
 * A missing image resolves to no entry — `DeckObjectView` draws its own
 * placeholder, which is more useful mid-talk than an error banner over an
 * otherwise fine slide.
 *
 * Returns a `refresh(src)` alongside the map: a TeX-figure object's PNG is
 * overwritten **at the same path** every time its source recompiles, so the
 * ordinary "fetch only what's missing" effect below would never notice the new
 * bytes. The editor calls `refresh` right after it rewrites such a file to evict
 * the stale blob URL and force a re-fetch.
 */
export function useDeckImages(deck: Deck | null, path: string, scope: string | null) {
  const [assets, setAssets] = useState<Map<string, string>>(new Map());

  const refresh = useCallback((src: string) => {
    setAssets((cur) => {
      const url = cur.get(src);
      if (!url) return cur;
      URL.revokeObjectURL(url);
      const next = new Map(cur);
      next.delete(src);
      return next;
    });
  }, []);

  const wantedSrcs = useMemo(() => {
    const out = new Set<string>();
    for (const s of deck?.slides ?? []) {
      for (const o of s.objects) if (o.kind === "image") out.add(o.src);
    }
    return out;
  }, [deck]);

  useEffect(() => {
    let live = true;
    const dir = dirOf(path);
    const missing = [...wantedSrcs].filter((s) => !assets.has(s));
    if (missing.length === 0) return;
    void (async () => {
      const added = new Map<string, string>();
      for (const rel of missing) {
        try {
          const bytes = await readFileBytes(resolveRel(dir, rel), scope);
          added.set(rel, URL.createObjectURL(new Blob([new Uint8Array(bytes)])));
        } catch {
          /* placeholder, see above */
        }
      }
      if (!live) {
        added.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      if (added.size) setAssets((cur) => new Map([...cur, ...added]));
    })();
    return () => {
      live = false;
    };
  }, [wantedSrcs, assets, path, scope]);

  useEffect(() => {
    // Drop URLs for images no longer anywhere in the deck.
    const stale = [...assets.keys()].filter((k) => !wantedSrcs.has(k));
    if (stale.length === 0) return;
    setAssets((cur) => {
      const next = new Map(cur);
      for (const k of stale) {
        URL.revokeObjectURL(next.get(k)!);
        next.delete(k);
      }
      return next;
    });
  }, [wantedSrcs, assets]);

  // Unmount: revoke whatever is left. Its own effect with an empty dep list so it
  // fires once, at teardown, rather than on every asset change.
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  useEffect(
    () => () => {
      assetsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  return { assets, refresh };
}

/**
 * Decoded interstitial clips, keyed by interstitial id.
 *
 * Decoded lazily and kept for the session: a clip costs real memory (every GIF
 * frame is a full-canvas RGBA copy), so `gifPlayback` caps each one, and the
 * bitmaps are explicitly closed when they leave the deck.
 */
export function useDeckGifs(
  interstitials: readonly Interstitial[],
  path: string,
  scope: string | null,
) {
  const [gifs, setGifs] = useState<Map<string, DecodedGif>>(new Map());

  useEffect(() => {
    let live = true;
    const dir = dirOf(path);
    const missing = interstitials.filter((a) => !gifs.has(a.id));
    if (missing.length === 0) return;
    void (async () => {
      const added = new Map<string, DecodedGif>();
      for (const a of missing) {
        try {
          const bytes = await readFileBytes(resolveRel(dir, a.src), scope);
          added.set(a.id, await decodeInterstitial(new Uint8Array(bytes)));
        } catch {
          // A clip that will not decode shows as "Loading animation…" in the
          // presenter rather than taking the talk down.
        }
      }
      if (!live) {
        added.forEach((g) => disposeGif(g));
        return;
      }
      if (added.size) setGifs((cur) => new Map([...cur, ...added]));
    })();
    return () => {
      live = false;
    };
  }, [interstitials, gifs, path, scope]);

  const gifsRef = useRef(gifs);
  gifsRef.current = gifs;
  useEffect(
    () => () => {
      gifsRef.current.forEach((g) => disposeGif(g));
    },
    [],
  );

  return gifs;
}
