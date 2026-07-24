/**
 * Text metrics and line breaking for the deck — **the single source of truth for
 * both the editor and the PDF exporter**.
 *
 * This module exists to close the classic failure of a WYSIWYG-over-PDF editor:
 * the editor wraps text using the browser's font metrics, the exporter wraps it
 * using the PDF's, the two disagree by a few percent, and the export silently
 * reflows — usually one word onto a new line, usually on the slide you cared
 * about. Nothing about the editor's rendering can prevent that; only sharing the
 * measurement can.
 *
 * So the deck measures with **pdf-lib's own metrics on both sides**. One
 * throwaway `PDFDocument` is created at startup purely to embed the standard-14
 * fonts and expose their `widthOfTextAtSize`; the stage lays out with it, the
 * exporter lays out with it, and the export is identical to the screen by
 * construction rather than by luck.
 *
 * The accepted cost is that a deck can use **only the standard-14 fonts**.
 * Arbitrary TTFs would need `@pdf-lib/fontkit`, a font-embedding UI, and would
 * reintroduce exactly the drift this avoids. On Linux, Helvetica/Times/Courier
 * resolve to the metric-compatible Nimbus and Liberation families, so the painted
 * glyphs match the measured advances too.
 */

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { FontFamily, ListStyle, TextStyle } from "./model";

/** The 12 faces a deck can use: three families × regular/bold/italic/bold-italic. */
const FACES: Record<FontFamily, Record<string, StandardFonts>> = {
  sans: {
    r: StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  serif: {
    r: StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  mono: {
    r: StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

/** Which of the four variants a style selects. */
export function faceKey(bold: boolean, italic: boolean): string {
  return bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
}

/** The pdf-lib standard font a style maps to — used by the exporter to embed. */
export function standardFontFor(style: {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}): StandardFonts {
  return FACES[style.family][faceKey(style.bold, style.italic)];
}

export interface TextMetrics {
  /** Advance width of `text` at `size` points, in points. */
  width(text: string, style: MeasureStyle, size?: number): number;
  /** Ascender-to-descender height at `size` points. */
  height(style: MeasureStyle, size?: number): number;
  /**
   * Baseline offset from the top of a line, in points.
   *
   * The exporter needs this and the renderer does not: pdf-lib's `drawText`
   * positions a **baseline**, while CSS positions a line box. Without it every
   * exported line sits one ascender too high.
   */
  ascent(style: MeasureStyle, size?: number): number;
}

export type MeasureStyle = Pick<TextStyle, "family" | "bold" | "italic" | "size">;

let cached: Promise<TextMetrics> | null = null;

/**
 * Embed the standard-14 faces once and expose their metrics.
 *
 * Memoized at module scope: the document exists only to own the font objects, is
 * never written, and building a second one per deck tab would be pure waste.
 */
export function loadMetrics(): Promise<TextMetrics> {
  if (cached) return cached;
  cached = (async () => {
    const doc = await PDFDocument.create();
    const fonts = new Map<string, PDFFont>();
    for (const family of Object.keys(FACES) as FontFamily[]) {
      for (const variant of Object.keys(FACES[family])) {
        fonts.set(`${family}-${variant}`, await doc.embedFont(FACES[family][variant]));
      }
    }
    const pick = (s: MeasureStyle): PDFFont =>
      fonts.get(`${s.family}-${faceKey(s.bold, s.italic)}`) ?? fonts.get("sans-r")!;
    return {
      width(text, style, size) {
        if (!text) return 0;
        try {
          return pick(style).widthOfTextAtSize(text, size ?? style.size);
        } catch {
          // A character outside WinAnsi throws rather than measuring. Falling
          // back to an em-based estimate keeps the layout sane instead of
          // collapsing the line to zero — the export will substitute the glyph
          // anyway, and a slightly wrong width beats a broken paragraph.
          return text.length * (size ?? style.size) * 0.5;
        }
      },
      height(style, size) {
        return pick(style).heightAtSize(size ?? style.size);
      },
      ascent(style, size) {
        // `descender: false` gives the ascent alone, which is exactly the drop
        // from a line box's top to its baseline.
        return pick(style).heightAtSize(size ?? style.size, { descender: false });
      },
    };
  })();
  return cached;
}

/** Drop the memo. Tests only. */
export function resetMetrics(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

/** Gap between a list marker and its text, as a multiple of the font size. */
export const MARKER_GAP = 0.45;

export interface WrappedLine {
  text: string;
  /** The bullet/number, on the first visual line of a list item only. */
  marker?: string;
  /** Left inset for this line's text, in points. */
  indent: number;
  /** Measured advance width of `text`, in points. */
  width: number;
  /** Which source line (0-based) this came from — the build-step key for a
   *  staggered list reveal. */
  source: number;
}

/** The bullet/number a list line gets. Pure, and shared with the renderer so the
 *  editor and the export never spell an enumeration differently. */
export function listMarker(kind: ListStyle["kind"], index: number, start: number): string {
  const n = start + index;
  switch (kind) {
    case "number":
      return `${n}.`;
    case "alpha":
      // Wraps past 26 rather than going to "aa": a slide with 27 list items has
      // a bigger problem than its numbering.
      return `${String.fromCharCode(97 + ((n - 1) % 26))}.`;
    case "roman":
      return `${toRoman(n)}.`;
    default:
      return "•";
  }
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function toRoman(n: number): string {
  let out = "";
  let left = Math.max(1, Math.floor(n));
  for (const [value, sym] of ROMAN) {
    while (left >= value) {
      out += sym;
      left -= value;
    }
  }
  return out;
}

/**
 * Break `text` to fit `width` points.
 *
 * Greedy word wrapping, which is what every slide tool does and what readers
 * expect; a Knuth–Plass optimum would be prettier and would also disagree with
 * every other renderer the author compares against.
 *
 * A word longer than the whole line is broken by character rather than allowed
 * to overflow — a pasted URL should look cramped, not spill off the slide.
 * Explicit newlines always break, and each becomes its own list item.
 */
export function wrapText(
  metrics: TextMetrics,
  text: string,
  style: MeasureStyle,
  width: number,
  list?: ListStyle,
): WrappedLine[] {
  const out: WrappedLine[] = [];
  const paragraphs = text.split("\n");
  const markerIndent = list
    ? Math.max(
        ...paragraphs.map((_p, i) =>
          metrics.width(listMarker(list.kind, i, list.start), style),
        ),
      ) + style.size * MARKER_GAP
    : 0;
  const avail = Math.max(1, width - markerIndent);

  paragraphs.forEach((para, pi) => {
    const marker = list ? listMarker(list.kind, pi, list.start) : undefined;
    const words = para.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    let first = true;

    const push = () => {
      out.push({
        text: line,
        ...(first && marker ? { marker } : {}),
        indent: markerIndent,
        width: metrics.width(line, style),
        source: pi,
      });
      first = false;
      line = "";
    };

    if (words.length === 0) {
      push();
      return;
    }

    for (const word of words) {
      const candidate = line + word;
      if (metrics.width(candidate, style) <= avail || line === "") {
        // A single word wider than the line must still be broken, or it spills.
        if (line === "" && metrics.width(word, style) > avail && !/^\s+$/.test(word)) {
          let chunk = "";
          for (const ch of word) {
            if (chunk && metrics.width(chunk + ch, style) > avail) {
              line = chunk;
              push();
              chunk = "";
            }
            chunk += ch;
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        // Trailing whitespace never justifies a break of its own.
        line = line.replace(/\s+$/, "");
        push();
        line = /^\s+$/.test(word) ? "" : word;
      }
    }
    line = line.replace(/\s+$/, "");
    push();
  });

  return out;
}

/** Total laid-out height of `lines`, in points. */
export function textHeight(lines: readonly WrappedLine[], style: TextStyle): number {
  return lines.length * style.size * style.lineHeight;
}

/**
 * Where a line's text starts, in points from the box's left inner edge, honouring
 * alignment. Shared by the renderer and the exporter — a centred line that is
 * centred differently in the export is the same bug as a reflowed one.
 */
export function lineOffset(line: WrappedLine, style: TextStyle, width: number): number {
  const avail = width - line.indent;
  switch (style.align) {
    case "center":
      return line.indent + Math.max(0, (avail - line.width) / 2);
    case "right":
      return line.indent + Math.max(0, avail - line.width);
    default:
      return line.indent;
  }
}
