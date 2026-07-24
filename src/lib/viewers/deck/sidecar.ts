/**
 * Reading, writing and — the part that matters — **re-anchoring** a deck sidecar
 * (`docs/deck_presenter_plan.md` §2.1/§2.2). All pure: nothing here touches the
 * filesystem, so every branch is testable and the viewer owns the I/O.
 *
 * Two jobs, and the second is the reason the feature is usable at all.
 *
 * **Parsing is defensive, not trusting.** A deck is hand-editable text under git,
 * so it arrives having possibly been merged badly, half-edited in the YAML tree,
 * or written by a newer build. `normalizeDeck` coerces every field to something
 * renderable and drops what it cannot, because a viewer that throws on a bad
 * merge is a viewer that loses the author's other twenty slides too.
 *
 * **Re-anchoring survives a recompile.** TeX rewrites the base PDF whenever the
 * author fixes a typo, and inserting one slide shifts every page number after it.
 * `reconcile` re-attaches layers to the pages they belong to, and — the invariant
 * the whole design hangs on — **never silently drops one**. Anything it cannot
 * place lands in `deck.detached` for the re-attach UI. A recompile that quietly
 * eats annotations is what makes people stop trusting a tool.
 */

import {
  DECK_VERSION,
  type Deck,
  type DetachedLayer,
  type Slide,
  blankSlide,
  defaultTheme,
  defaultTextStyle,
  emptyDeck,
  newSlideId,
  type DeckObject,
  type ObjectList,
  type TextStyle,
  type Transition,
  type Interstitial,
  newObjectId,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
} from "./model";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The deck sidecar beside a base PDF: `talk.pdf` → `talk.eldeck.json`. */
export function deckPathForPdf(pdfPath: string): string {
  return `${pdfPath.replace(/\.pdf$/i, "")}.eldeck.json`;
}

/** The base PDF a deck sidecar names by convention, when it records none. */
export function pdfPathForDeck(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.pdf`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Two-space JSON with a trailing newline — the deck is a *tracked source file*,
 * so it is formatted to diff line-by-line rather than to be compact. A one-line
 * deck would make every edit a whole-file conflict.
 */
export function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(deck, null, 2)}\n`;
}

export interface ParseResult {
  deck: Deck;
  /** Set when the text could not be read at all and `deck` is a fresh empty one. */
  error?: string;
  /** Set when the file parsed but something in it was repaired or discarded. */
  repaired?: string;
}

export function parseDeck(text: string, base: string | null = null): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { deck: emptyDeck(base), error: `not valid JSON: ${String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { deck: emptyDeck(base), error: "not a deck object" };
  }
  return normalizeDeck(raw as Record<string, unknown>, base);
}

// --- coercion helpers ------------------------------------------------------
// Each returns the fallback rather than throwing: see the module note on why a
// malformed field must never cost the author the rest of the deck.

const num = (v: unknown, fb: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fb;

const str = (v: unknown, fb: string): string => (typeof v === "string" ? v : fb);

const bool = (v: unknown, fb: boolean): boolean =>
  typeof v === "boolean" ? v : fb;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;

/** A hex color, or the fallback. Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const color = (v: unknown, fb: string): string =>
  typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fb;

/** Clamp into 0..1. Geometry outside the page is legal (an object can hang off
 *  the edge) so only genuinely unbounded fields use this. */
const unit = (v: unknown, fb: number): number => {
  const n = num(v, fb);
  return Math.min(1, Math.max(0, n));
};

function normalizeTextStyle(v: unknown): TextStyle {
  const d = defaultTextStyle();
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  return {
    family: oneOf(o.family, ["sans", "serif", "mono"] as const, d.family),
    size: Math.max(1, num(o.size, d.size)),
    bold: bool(o.bold, d.bold),
    italic: bool(o.italic, d.italic),
    color: color(o.color, d.color),
    align: oneOf(o.align, ["left", "center", "right"] as const, d.align),
    lineHeight: Math.max(0.5, num(o.lineHeight, d.lineHeight)),
  };
}

function normalizeObject(v: unknown): DeckObject | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  const common = {
    id: str(o.id, "") || newObjectId(),
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: Math.max(0, num(o.w, 0.2)),
    h: Math.max(0, num(o.h, 0.1)),
    rot: num(o.rot, 0),
    opacity: unit(o.opacity, 1),
    ...(bool(o.locked, false) ? { locked: true } : {}),
    ...(bool(o.hidden, false) ? { hidden: true } : {}),
    ...(o.build && typeof o.build === "object"
      ? {
          build: {
            step: Math.max(0, Math.round(num((o.build as Record<string, unknown>).step, 0))),
            effect: oneOf(
              (o.build as Record<string, unknown>).effect,
              ["none", "fade", "rise", "scale", "wipe", "draw"] as const,
              "fade",
            ),
          },
        }
      : {}),
  };

  switch (kind) {
    case "text":
      return {
        ...common,
        kind: "text",
        text: str(o.text, ""),
        style: normalizeTextStyle(o.style),
        ...(o.list && typeof o.list === "object"
          ? {
              list: {
                kind: oneOf(
                  (o.list as Record<string, unknown>).kind,
                  ["bullet", "number", "alpha", "roman"] as const,
                  "bullet",
                ),
                start: Math.max(1, Math.round(num((o.list as Record<string, unknown>).start, 1))),
              },
            }
          : {}),
        ...(typeof o.fill === "string" ? { fill: color(o.fill, "#ffffff") } : {}),
        ...(typeof o.stroke === "string" ? { stroke: color(o.stroke, "#111111") } : {}),
        ...(typeof o.strokeWidth === "number" ? { strokeWidth: Math.max(0, o.strokeWidth) } : {}),
        padding: Math.max(0, num(o.padding, 2)),
      };
    case "image":
      // An image with no source cannot render and cannot be repaired — dropping
      // it is the honest outcome, and it is reported as a repair.
      if (typeof o.src !== "string" || !o.src) return null;
      return {
        ...common,
        kind: "image",
        src: o.src,
        fit: oneOf(o.fit, ["contain", "cover", "stretch"] as const, "contain"),
        ...(typeof o.texSrc === "string" && o.texSrc ? { texSrc: o.texSrc } : {}),
      };
    case "shape":
      return {
        ...common,
        kind: "shape",
        shape: oneOf(
          o.shape,
          ["rect", "roundrect", "ellipse", "line", "arrow", "callout"] as const,
          "rect",
        ),
        ...(typeof o.fill === "string" ? { fill: color(o.fill, "#ffffff") } : {}),
        stroke: color(o.stroke, "#111111"),
        strokeWidth: Math.max(0, num(o.strokeWidth, 1.5)),
        ...(typeof o.radius === "number" ? { radius: unit(o.radius, 0.1) } : {}),
        ...(typeof o.head === "string"
          ? { head: oneOf(o.head, ["none", "arrow", "dot", "bar"] as const, "none") }
          : {}),
        ...(typeof o.tail === "string"
          ? { tail: oneOf(o.tail, ["none", "arrow", "dot", "bar"] as const, "none") }
          : {}),
      };
    case "icon":
      if (typeof o.icon !== "string" || !o.icon) return null;
      return {
        ...common,
        kind: "icon",
        icon: o.icon,
        color: color(o.color, "#111111"),
        strokeWidth: Math.max(0, num(o.strokeWidth, 1.5)),
      };
    default:
      // An unknown kind is most likely a NEWER build's object. Dropping it is
      // lossy but unavoidable — we cannot render or round-trip what we can't
      // model — so it is counted as a repair rather than passed over in silence.
      return null;
  }
}

function normalizeInterstitial(v: unknown): Interstitial | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.src !== "string" || !o.src) return null;
  const adv = (o.advance ?? {}) as Record<string, unknown>;
  const on = oneOf(adv.on, ["manual", "end", "end-after"] as const, "manual");
  return {
    id: str(o.id, "") || `g${Math.random().toString(36).slice(2, 8)}`,
    src: o.src,
    fit: oneOf(o.fit, ["contain", "cover"] as const, "contain"),
    background: color(o.background, "#000000"),
    advance:
      on === "end-after"
        ? { on, loops: Math.max(1, Math.round(num(adv.loops, 1))) }
        : { on },
    poster: Math.max(0, Math.round(num(o.poster, 0))),
  };
}

function normalizeObjects(v: unknown, report: (what: string) => void): ObjectList {
  if (!Array.isArray(v)) return [];
  const out: ObjectList = [];
  for (const raw of v) {
    const o = normalizeObject(raw);
    if (o) out.push(o);
    else report("object");
  }
  return out;
}

function normalizeSlide(v: unknown, report: (what: string) => void): Slide | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const anchorRaw = (o.anchor ?? {}) as Record<string, unknown>;
  const page = Math.max(1, Math.round(num(anchorRaw.page, 1)));
  const after = normalizeInterstitial(o.after);
  return {
    id: str(o.id, "") || newSlideId(),
    anchor: {
      page,
      ...(typeof anchorRaw.line === "number"
        ? { line: Math.max(1, Math.round(anchorRaw.line)) }
        : {}),
      ...(typeof anchorRaw.print === "string" ? { print: anchorRaw.print } : {}),
    },
    objects: normalizeObjects(o.objects, report),
    notes: str(o.notes, ""),
    transition: oneOf(
      o.transition,
      ["none", "fade", "push", "wipe"] as const satisfies readonly Transition[],
      "none",
    ),
    ...(after ? { after } : {}),
  };
}

/**
 * Coerce an arbitrary parsed object into a renderable {@link Deck}, reporting
 * whatever had to be repaired. Never throws.
 */
export function normalizeDeck(
  raw: Record<string, unknown>,
  base: string | null = null,
): ParseResult {
  const repairs: string[] = [];
  const report = (what: string) => repairs.push(what);

  const themeRaw = (raw.theme ?? {}) as Record<string, unknown>;
  const dt = defaultTheme();

  const slides: Slide[] = [];
  if (Array.isArray(raw.slides)) {
    for (const s of raw.slides) {
      const slide = normalizeSlide(s, report);
      if (slide) slides.push(slide);
      else report("slide");
    }
  }

  const detached: DetachedLayer[] = [];
  if (Array.isArray(raw.detached)) {
    for (const d of raw.detached) {
      if (!d || typeof d !== "object") continue;
      const o = d as Record<string, unknown>;
      const fromRaw = (o.from ?? {}) as Record<string, unknown>;
      detached.push({
        from: { page: Math.max(1, Math.round(num(fromRaw.page, 1))) },
        objects: normalizeObjects(o.objects, report),
        notes: str(o.notes, ""),
      });
    }
  }

  const deck: Deck = {
    version: DECK_VERSION,
    base: typeof raw.base === "string" ? raw.base : base,
    source: typeof raw.source === "string" ? raw.source : null,
    pageWidth: Math.max(1, num(raw.pageWidth, DEFAULT_PAGE_WIDTH)),
    pageHeight: Math.max(1, num(raw.pageHeight, DEFAULT_PAGE_HEIGHT)),
    slides,
    detached,
    theme: {
      text: normalizeTextStyle(themeRaw.text),
      shapeFill: color(themeRaw.shapeFill, dt.shapeFill),
      shapeStroke: color(themeRaw.shapeStroke, dt.shapeStroke),
      shapeStrokeWidth: Math.max(0, num(themeRaw.shapeStrokeWidth, dt.shapeStrokeWidth)),
      iconColor: color(themeRaw.iconColor, dt.iconColor),
      iconStrokeWidth: Math.max(0, num(themeRaw.iconStrokeWidth, dt.iconStrokeWidth)),
      margin: unit(themeRaw.margin, dt.margin),
      exportInterstitials: bool(themeRaw.exportInterstitials, dt.exportInterstitials),
    },
  };

  const version = num(raw.version, DECK_VERSION);
  if (version > DECK_VERSION) {
    repairs.push(`written by a newer Eldrun (deck v${version})`);
  }

  return {
    deck,
    ...(repairs.length ? { repaired: summarize(repairs) } : {}),
  };
}

function summarize(repairs: string[]): string {
  const counts = new Map<string, number>();
  for (const r of repairs) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([what, n]) => (n > 1 ? `${n} ${what}s` : what))
    .join(", ");
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/** A page of the base PDF, as the viewer reads it out of pdf.js. */
export interface BasePage {
  /** 1-based. */
  page: number;
  /** Page box in points. */
  width: number;
  height: number;
  /** Extracted text, already collapsed to single spaces by the caller. */
  text: string;
  /**
   * Source lines SyncTeX says contributed to this page, when the deck has a
   * `.tex`. This is the *good* anchor — see {@link SlideAnchor}.
   */
  lines?: number[];
}

/** How many characters of page text the fingerprint covers. Enough to tell two
 *  slides apart, short enough that editing a slide's body does not break it. */
export const FINGERPRINT_CHARS = 200;

/**
 * A stable id for a base page's *content*.
 *
 * Deliberately coarse: the page box plus the first {@link FINGERPRINT_CHARS}
 * characters, whitespace-collapsed and lowercased. It has to survive the author
 * fixing a typo further down the slide (or it re-anchors constantly) while still
 * telling two slides apart (or it re-anchors wrongly). Text before layout, so a
 * font change does not move it.
 */
export function fingerprint(p: Pick<BasePage, "width" | "height" | "text">): string {
  const head = p.text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FINGERPRINT_CHARS)
    .toLowerCase();
  return `${Math.round(p.width)}x${Math.round(p.height)}:${hash(head)}`;
}

/** FNV-1a, 32-bit, hex. Not cryptographic — it only has to be stable and cheap. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface ReconcileResult {
  deck: Deck;
  /** Slides whose base page moved under them. */
  moved: number;
  /** Slides added because the base gained pages. */
  added: number;
  /** Layers that could not be re-attached and went to `deck.detached`. */
  detached: number;
  /** True when nothing had to change — the overwhelmingly common case. */
  unchanged: boolean;
}

/** Does a slide hold anything worth preserving? An empty one is free to drop. */
function hasContent(s: Slide): boolean {
  return s.objects.length > 0 || s.notes.trim() !== "" || s.after != null;
}

/**
 * Re-attach `deck`'s slides to `pages` after the base PDF changed.
 *
 * Resolution order, cheapest and most trustworthy first:
 *
 *  1. **Nothing moved** — same page count and every recorded fingerprint still
 *     matches its page. Returns untouched (bar refreshed fingerprints).
 *  2. **SyncTeX line** — a slide anchored to source line *L* claims the page
 *     whose `lines` contain *L*. Survives insertion/deletion/reordering of other
 *     slides, because it is anchored to the author's own source.
 *  3. **Fingerprint** — for an imported PDF with no source.
 *  4. **Order** — remaining slides fill remaining pages front to back.
 *
 * Slides with content that still find no page go to `deck.detached`; empty ones
 * are dropped, since there is nothing to lose. Pages with no slide get a blank
 * one, so the deck always covers the whole base.
 */
export function reconcile(deck: Deck, pages: BasePage[]): ReconcileResult {
  if (pages.length === 0) {
    // A base that reports no pages is a failed load, not an empty document.
    // Changing nothing is the only safe response — wiping every layer because
    // pdf.js hiccuped would be exactly the silent loss this module exists to
    // prevent.
    return { deck, moved: 0, added: 0, detached: 0, unchanged: true };
  }

  const prints = pages.map((p) => fingerprint(p));

  // 1 — fast path.
  const sameCount = deck.slides.length === pages.length;
  const allMatch =
    sameCount &&
    deck.slides.every((s, i) => {
      if (s.anchor.page !== i + 1) return false;
      return s.anchor.print == null || s.anchor.print === prints[i];
    });
  if (allMatch) {
    return {
      deck: {
        ...deck,
        pageWidth: pages[0].width,
        pageHeight: pages[0].height,
        slides: deck.slides.map((s, i) => ({
          ...s,
          anchor: { ...s.anchor, page: i + 1, print: prints[i] },
        })),
      },
      moved: 0,
      added: 0,
      detached: 0,
      unchanged: true,
    };
  }

  // A page may be backed by MORE THAN ONE slide — that is what makes duplicating a
  // slide durable: the copy shares its original's page (same line/fingerprint) and
  // both survive a reload. So placement records which pages are *covered* rather
  // than reserving each page for a single slide; only the order fallback (step 4),
  // which has no evidence to share on, still hands out one uncovered page apiece.
  const placed = new Map<string, number>(); // slide id → 0-based page index
  const covered = new Set<number>();
  const place = (slide: Slide, idx: number): void => {
    if (idx < 0 || idx >= pages.length) return;
    placed.set(slide.id, idx);
    covered.add(idx);
  };

  // 2 — SyncTeX line.
  const pageOfLine = new Map<number, number>();
  pages.forEach((p, i) => {
    for (const l of p.lines ?? []) if (!pageOfLine.has(l)) pageOfLine.set(l, i);
  });
  for (const s of deck.slides) {
    if (s.anchor.line == null) continue;
    const idx = pageOfLine.get(s.anchor.line);
    if (idx != null) place(s, idx);
  }

  // 3 — fingerprint. Only unique fingerprints are trusted: two identical pages
  // (a repeated section divider, say) carry no information about which slide is
  // which, and guessing there would shuffle layers between them.
  const printIdx = new Map<string, number[]>();
  prints.forEach((p, i) => {
    const list = printIdx.get(p);
    if (list) list.push(i);
    else printIdx.set(p, [i]);
  });
  for (const s of deck.slides) {
    if (placed.has(s.id) || s.anchor.print == null) continue;
    const hits = printIdx.get(s.anchor.print);
    if (hits?.length === 1) place(s, hits[0]);
  }

  // 4 — order. Remaining slides take remaining UNCOVERED pages, front to back,
  // preserving their relative order so a deck that merely gained a page at the end
  // does the obvious thing.
  let cursor = 0;
  const orphans: Slide[] = [];
  for (const s of deck.slides) {
    if (placed.has(s.id)) continue;
    while (cursor < pages.length && covered.has(cursor)) cursor += 1;
    if (cursor < pages.length) place(s, cursor);
    else orphans.push(s);
  }

  // Assemble preserving the deck's OWN slide order. The presentation sequence is
  // the author's, not the base PDF's page order — a manual reorder must survive a
  // reload, and a recompile only re-anchors each slide to the page it now backs.
  // (A slide keeps the page it claimed above, so a pure reorder re-claims every
  // page by fingerprint/line and `moved` stays 0.)
  let moved = 0;
  let added = 0;
  const slides: Slide[] = [];
  for (const s of deck.slides) {
    const idx = placed.get(s.id);
    if (idx == null) continue; // an orphan — collected into `newlyDetached` below
    if (idx + 1 !== s.anchor.page) moved += 1;
    slides.push({ ...s, anchor: { ...s.anchor, page: idx + 1, print: prints[idx] } });
  }

  // Cover every base page: a page no slide claimed is a frame the source just
  // grew, so it gets a blank slide, spliced in before the first slide backing a
  // later page (i.e. in page order relative to the placed slides) rather than
  // dumped at the end. Blank slides carry nothing, so placement is cosmetic, never
  // lossy.
  for (let i = 0; i < pages.length; i += 1) {
    if (covered.has(i)) continue;
    added += 1;
    let at = slides.length;
    for (let j = 0; j < slides.length; j += 1) {
      if (slides[j].anchor.page > i + 1) {
        at = j;
        break;
      }
    }
    slides.splice(at, 0, { ...blankSlide(i + 1), anchor: { page: i + 1, print: prints[i] } });
  }

  const newlyDetached: DetachedLayer[] = orphans
    .filter(hasContent)
    .map((s) => ({ from: s.anchor, objects: s.objects, notes: s.notes }));

  return {
    deck: {
      ...deck,
      pageWidth: pages[0].width,
      pageHeight: pages[0].height,
      slides,
      detached: [...deck.detached, ...newlyDetached],
    },
    moved,
    added,
    detached: newlyDetached.length,
    unchanged: false,
  };
}

/**
 * Move a detached layer's objects back onto a slide, appending them on top.
 *
 * Re-attaching merges rather than replaces: the slide may have gained its own
 * content since the layer came adrift, and silently overwriting it would be the
 * same loss this module exists to prevent, just in the other direction.
 */
export function reattach(deck: Deck, detachedIndex: number, slideIndex: number): Deck {
  const layer = deck.detached[detachedIndex];
  if (!layer || slideIndex < 0 || slideIndex >= deck.slides.length) return deck;
  return {
    ...deck,
    slides: deck.slides.map((s, i) =>
      i === slideIndex
        ? {
            ...s,
            objects: [...s.objects, ...layer.objects],
            notes: [s.notes, layer.notes].filter((t) => t.trim()).join("\n\n"),
          }
        : s,
    ),
    detached: deck.detached.filter((_, i) => i !== detachedIndex),
  };
}
