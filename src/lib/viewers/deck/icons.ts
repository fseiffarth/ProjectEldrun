import type { TranslationKey } from "../../i18n";
/**
 * The deck's built-in icon library — bundled, offline, and shaped by the export.
 *
 * Every icon is **SVG path data in a 24×24 box**, because that is the only vector
 * form pdf-lib can emit (`drawSvgPath`): no `<circle>`, no groups, no gradients,
 * no external sprite sheet. Storing paths therefore means the stage's `<path>`
 * and the exported PDF draw from one geometry source and cannot disagree. It is
 * also why the set is monochrome and stroke-based — a Lucide/Feather shape — and
 * why nothing here is fetched at runtime, which keeps the app's offline story
 * intact.
 *
 * Directional variants are **derived by rotation**, not hand-authored four times.
 * One `arrow-right` becomes left/up/down by a `rotate` field the renderer and the
 * exporter both honour: a quarter of the path data to get wrong, and a fix to the
 * arrowhead fixes all four.
 */

export type IconCategory =
  | "arrows"
  | "shapes"
  | "ui"
  | "media"
  | "files"
  | "science"
  | "tech"
  | "people";

export interface IconDef {
  key: string;
  /** i18n key for the picker's caption. The name is user-facing copy, so it
   *  lives in `lib/i18n`; resolve it with `iconLabel`, never by hand. */
  labelKey: TranslationKey;
  /** Set only on a generated directional variant: the direction word appended to
   *  the base name, so "Arrow" + "right" composes in the reader's language. */
  directionKey?: TranslationKey;
  category: IconCategory;
  /** Path data in a 24×24 box. Rendered stroked unless `filled`. */
  paths: string[];
  /** Degrees clockwise about (12, 12). Lets one glyph serve four directions. */
  rotate?: number;
  /** Filled rather than stroked (a play triangle, a solid dot). */
  filled?: boolean;
  /** Extra search terms beyond the label. */
  alias?: string[];
}

/** A circle as two arcs — the only portable idiom, since `<circle>` cannot export. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`;

/** Base glyphs. Directional variants are generated from these below. */
const BASE: IconDef[] = [
  // ── arrows ───────────────────────────────────────────────────────────────
  { key: "arrow", labelKey: "deckIcon.arrow", category: "arrows", paths: ["M3 12 H20", "M14 6 L20 12 L14 18"] },
  { key: "chevron", labelKey: "deckIcon.chevron", category: "arrows", paths: ["M9 5 L16 12 L9 19"] },
  {
    key: "arrow-both",
    labelKey: "deckIcon.arrow-both",
    category: "arrows",
    paths: ["M3 12 H21", "M8 7 L3 12 L8 17", "M16 7 L21 12 L16 17"],
  },
  {
    key: "arrow-curve",
    labelKey: "deckIcon.arrow-curve",
    category: "arrows",
    paths: ["M5 18 C5 9 12 6 19 6", "M14 2 L19 6 L14 10"],
  },
  {
    key: "refresh",
    labelKey: "deckIcon.refresh",
    category: "arrows",
    paths: ["M20 12 A8 8 0 1 1 14.5 4.5", "M20 3 V9 H14"],
    alias: ["cycle", "reload", "loop"],
  },
  {
    key: "return",
    labelKey: "deckIcon.return",
    category: "arrows",
    paths: ["M20 6 V12 a4 4 0 0 1-4 4 H5", "M9 12 L5 16 L9 20"],
    alias: ["enter"],
  },

  // ── shapes ───────────────────────────────────────────────────────────────
  { key: "square", labelKey: "deckIcon.square", category: "shapes", paths: ["M4 4 H20 V20 H4 Z"] },
  { key: "circle", labelKey: "deckIcon.circle", category: "shapes", paths: [circle(12, 12, 9)] },
  { key: "triangle", labelKey: "deckIcon.triangle", category: "shapes", paths: ["M12 3 L21 20 H3 Z"] },
  { key: "diamond", labelKey: "deckIcon.diamond", category: "shapes", paths: ["M12 3 L21 12 L12 21 L3 12 Z"] },
  {
    key: "hexagon",
    labelKey: "deckIcon.hexagon",
    category: "shapes",
    paths: ["M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z"],
  },
  {
    key: "star",
    labelKey: "deckIcon.star",
    category: "shapes",
    paths: [
      "M12 3 L14.6 9.3 L21.4 9.8 L16.2 14.2 L17.8 20.8 L12 17.2 L6.2 20.8 L7.8 14.2 L2.6 9.8 L9.4 9.3 Z",
    ],
  },
  {
    key: "heart",
    labelKey: "deckIcon.heart",
    category: "shapes",
    paths: ["M12 20.5 C4 15 3 11 3 9 A5 5 0 0 1 12 6.5 A5 5 0 0 1 21 9 C21 11 20 15 12 20.5 Z"],
  },
  { key: "dot", labelKey: "deckIcon.dot", category: "shapes", paths: [circle(12, 12, 5)], filled: true },

  // ── ui ───────────────────────────────────────────────────────────────────
  { key: "check", labelKey: "deckIcon.check", category: "ui", paths: ["M4 12.5 L9.5 18 L20 6"], alias: ["tick", "yes", "done"] },
  { key: "cross", labelKey: "deckIcon.cross", category: "ui", paths: ["M6 6 L18 18", "M18 6 L6 18"], alias: ["close", "no", "x"] },
  { key: "plus", labelKey: "deckIcon.plus", category: "ui", paths: ["M12 5 V19", "M5 12 H19"], alias: ["add"] },
  { key: "minus", labelKey: "deckIcon.minus", category: "ui", paths: ["M5 12 H19"], alias: ["remove", "subtract"] },
  {
    key: "search",
    labelKey: "deckIcon.search",
    category: "ui",
    paths: [circle(11, 11, 7), "M16 16 L21 21"],
    alias: ["find", "magnify"],
  },
  {
    key: "gear",
    labelKey: "deckIcon.gear",
    category: "ui",
    paths: [
      circle(12, 12, 4),
      "M12 2 V5",
      "M12 19 V22",
      "M2 12 H5",
      "M19 12 H22",
      "M5.2 5.2 L7.3 7.3",
      "M16.7 16.7 L18.8 18.8",
      "M18.8 5.2 L16.7 7.3",
      "M7.3 16.7 L5.2 18.8",
    ],
    alias: ["cog", "config", "options"],
  },
  { key: "home", labelKey: "deckIcon.home", category: "ui", paths: ["M3 11 L12 3 L21 11", "M6 9.5 V21 H18 V9.5"] },
  {
    key: "filter",
    labelKey: "deckIcon.filter",
    category: "ui",
    paths: ["M3 5 H21 L14 13 V20 L10 18 V13 Z"],
  },
  {
    key: "eye",
    labelKey: "deckIcon.eye",
    category: "ui",
    paths: ["M2 12 C5 7 8.5 5 12 5 C15.5 5 19 7 22 12 C19 17 15.5 19 12 19 C8.5 19 5 17 2 12 Z", circle(12, 12, 3)],
    alias: ["view", "watch", "show"],
  },
  {
    key: "lock",
    labelKey: "deckIcon.lock",
    category: "ui",
    paths: ["M7 10 V7 a5 5 0 0 1 10 0 V10", "M4.5 10 H19.5 V21 H4.5 Z"],
    alias: ["secure", "private"],
  },
  {
    key: "key",
    labelKey: "deckIcon.key",
    category: "ui",
    paths: [circle(15.5, 9, 4.5), "M12.3 12.2 L4 20.5", "M6.5 18 L9 20.5"],
    alias: ["password", "auth"],
  },
  {
    key: "warning",
    labelKey: "deckIcon.warning",
    category: "ui",
    paths: ["M12 3 L22 20 H2 Z", "M12 9.5 V14.5", "M12 17 V17.6"],
    alias: ["alert", "caution", "danger"],
  },
  { key: "info", labelKey: "deckIcon.info", category: "ui", paths: [circle(12, 12, 9), "M12 11 V17", "M12 7.4 V8"] },
  {
    key: "question",
    labelKey: "deckIcon.question",
    category: "ui",
    paths: [circle(12, 12, 9), "M9.4 9.6 a2.6 2.6 0 1 1 2.6 3 V14.5", "M12 17.2 V17.8"],
    alias: ["help", "unknown"],
  },
  {
    key: "idea",
    labelKey: "deckIcon.idea",
    category: "ui",
    paths: ["M9.5 18.5 H14.5", "M10.5 21.5 H13.5", "M12 2.5 A6 6 0 0 0 8.7 13.7 V16 H15.3 V13.7 A6 6 0 0 0 12 2.5 Z"],
    alias: ["lightbulb", "insight", "hint"],
  },
  {
    key: "pin",
    labelKey: "deckIcon.pin",
    category: "ui",
    paths: ["M12 22 C12 22 19 14.5 19 9.5 A7 7 0 1 0 5 9.5 C5 14.5 12 22 12 22 Z", circle(12, 9.5, 2.6)],
    alias: ["location", "marker", "place"],
  },
  { key: "tag", labelKey: "deckIcon.tag", category: "ui", paths: ["M3 12 V3.5 H11.5 L21 13 L13 21 Z", "M7 7.5 V7.6"] },
  { key: "flag", labelKey: "deckIcon.flag", category: "ui", paths: ["M5 22 V3", "M5 4 H19 L16 9.5 L19 15 H5"] },
  {
    key: "bookmark",
    labelKey: "deckIcon.bookmark",
    category: "ui",
    paths: ["M6 3 H18 V21 L12 16 L6 21 Z"],
    alias: ["save"],
  },
  {
    key: "target",
    labelKey: "deckIcon.target",
    category: "ui",
    paths: [circle(12, 12, 9), circle(12, 12, 5.5), circle(12, 12, 2)],
    alias: ["goal", "aim", "focus"],
  },
  {
    key: "link",
    labelKey: "deckIcon.link",
    category: "ui",
    paths: ["M10.5 13.5 a4.5 4.5 0 0 1 0-6.4 L13 4.6 a4.5 4.5 0 0 1 6.4 6.4 L18 12.4", "M13.5 10.5 a4.5 4.5 0 0 1 0 6.4 L11 19.4 a4.5 4.5 0 0 1-6.4-6.4 L6 11.6"],
    alias: ["chain", "url"],
  },
  {
    key: "trash",
    labelKey: "deckIcon.trash",
    category: "ui",
    paths: ["M4 7 H20", "M9.5 7 V4 H14.5 V7", "M6 7 L7.2 21 H16.8 L18 7"],
    alias: ["bin", "remove"],
  },
  {
    key: "pencil",
    labelKey: "deckIcon.pencil",
    category: "ui",
    paths: ["M4 20 H8 L20 8 L16 4 L4 16 Z", "M14.5 5.5 L18.5 9.5"],
    alias: ["write", "pen"],
  },
  { key: "copy", labelKey: "deckIcon.copy", category: "ui", paths: ["M9 9 H20 V20 H9 Z", "M15 9 V4 H4 V15 H9"] },
  {
    key: "grid",
    labelKey: "deckIcon.grid",
    category: "ui",
    paths: ["M4 4 H10.5 V10.5 H4 Z", "M13.5 4 H20 V10.5 H13.5 Z", "M4 13.5 H10.5 V20 H4 Z", "M13.5 13.5 H20 V20 H13.5 Z"],
  },
  {
    key: "list",
    labelKey: "deckIcon.list",
    category: "ui",
    paths: ["M9 6 H20", "M9 12 H20", "M9 18 H20", "M4.5 6 V6.1", "M4.5 12 V12.1", "M4.5 18 V18.1"],
  },
  {
    key: "layers",
    labelKey: "deckIcon.layers",
    category: "ui",
    paths: ["M12 3 L21 8 L12 13 L3 8 Z", "M3 12.5 L12 17.5 L21 12.5", "M3 16.5 L12 21.5 L21 16.5"],
    alias: ["stack"],
  },

  // ── media ────────────────────────────────────────────────────────────────
  { key: "play", labelKey: "deckIcon.play", category: "media", paths: ["M7 4 L20 12 L7 20 Z"], filled: true },
  { key: "pause", labelKey: "deckIcon.pause", category: "media", paths: ["M8 4 V20", "M16 4 V20"] },
  { key: "stop", labelKey: "deckIcon.stop", category: "media", paths: ["M6 6 H18 V18 H6 Z"], filled: true },
  {
    key: "camera",
    labelKey: "deckIcon.camera",
    category: "media",
    paths: ["M3 8 H7 L9 5 H15 L17 8 H21 V20 H3 Z", circle(12, 13.5, 4)],
    alias: ["photo"],
  },
  {
    key: "image",
    labelKey: "deckIcon.image",
    category: "media",
    paths: ["M3 5 H21 V19 H3 Z", "M3 16 L9 10 L13.5 14.5 L16.5 11.5 L21 16", "M8 9 V9.1"],
    alias: ["picture", "photo"],
  },
  {
    key: "video",
    labelKey: "deckIcon.video",
    category: "media",
    paths: ["M3 6 H15 V18 H3 Z", "M15 10 L21 7 V17 L15 14"],
    alias: ["film", "movie"],
  },
  {
    key: "mic",
    labelKey: "deckIcon.mic",
    category: "media",
    paths: ["M12 3 a3 3 0 0 1 3 3 V11 a3 3 0 0 1-6 0 V6 a3 3 0 0 1 3-3 Z", "M5.5 11 a6.5 6.5 0 0 0 13 0", "M12 17.5 V21.5"],
    alias: ["audio", "record", "voice"],
  },

  // ── files ────────────────────────────────────────────────────────────────
  { key: "file", labelKey: "deckIcon.file", category: "files", paths: ["M6 3 H14 L19 8 V21 H6 Z", "M14 3 V8 H19"] },
  { key: "folder", labelKey: "deckIcon.folder", category: "files", paths: ["M3 6 H9.5 L11.5 9 H21 V19.5 H3 Z"] },
  {
    key: "database",
    labelKey: "deckIcon.database",
    category: "files",
    paths: ["M4 6 a8 3 0 1 0 16 0 a8 3 0 1 0-16 0", "M4 6 V18 a8 3 0 0 0 16 0 V6", "M4 12 a8 3 0 0 0 16 0"],
    alias: ["db", "storage", "data"],
  },
  {
    key: "download",
    labelKey: "deckIcon.download",
    category: "files",
    paths: ["M12 3 V15", "M6.5 10 L12 15.5 L17.5 10", "M4 20.5 H20"],
  },
  {
    key: "upload",
    labelKey: "deckIcon.upload",
    category: "files",
    paths: ["M12 16 V4", "M6.5 9.5 L12 4 L17.5 9.5", "M4 20.5 H20"],
  },
  { key: "mail", labelKey: "deckIcon.mail", category: "files", paths: ["M3 5 H21 V19 H3 Z", "M3 6 L12 13 L21 6"], alias: ["email", "envelope"] },
  {
    key: "book",
    labelKey: "deckIcon.book",
    category: "files",
    paths: ["M12 6.5 C10 4.5 6.5 4 4 4.5 V19 C6.5 18.5 10 19 12 21", "M12 6.5 C14 4.5 17.5 4 20 4.5 V19 C17.5 18.5 14 19 12 21", "M12 6.5 V21"],
    alias: ["read", "paper", "reference"],
  },

  // ── science ──────────────────────────────────────────────────────────────
  {
    key: "flask",
    labelKey: "deckIcon.flask",
    category: "science",
    paths: ["M9.5 3 V9.5 L4 20.5 H20 L14.5 9.5 V3", "M8 3 H16", "M6.5 15.5 H17.5"],
    alias: ["chemistry", "lab", "experiment"],
  },
  {
    key: "atom",
    labelKey: "deckIcon.atom",
    category: "science",
    paths: [circle(12, 12, 2), "M2.5 12 a9.5 4 0 1 0 19 0 a9.5 4 0 1 0-19 0", "M12 2.5 a4 9.5 0 1 0 0 19 a4 9.5 0 1 0 0-19"],
    alias: ["physics", "science", "nucleus"],
  },
  {
    key: "chart-bar",
    labelKey: "deckIcon.chart-bar",
    category: "science",
    paths: ["M3.5 20.5 H20.5", "M6.5 20.5 V12 H10 V20.5", "M13.5 20.5 V5.5 H17 V20.5"],
    alias: ["graph", "histogram", "results"],
  },
  {
    key: "chart-line",
    labelKey: "deckIcon.chart-line",
    category: "science",
    paths: ["M3.5 3.5 V20.5 H20.5", "M6 16.5 L10.5 11 L14 14 L20 6"],
    alias: ["graph", "plot", "trend", "curve"],
  },
  {
    key: "chart-pie",
    labelKey: "deckIcon.chart-pie",
    category: "science",
    paths: [circle(12, 12, 9), "M12 3 V12 H21"],
    alias: ["graph", "share", "proportion"],
  },
  {
    key: "sigma",
    labelKey: "deckIcon.sigma",
    category: "science",
    paths: ["M17.5 5 H6.5 L13 12 L6.5 19 H17.5"],
    alias: ["sum", "total", "math"],
  },
  {
    key: "infinity",
    labelKey: "deckIcon.infinity",
    category: "science",
    paths: ["M8 8 a4 4 0 1 0 4 4 a4 4 0 1 1 4-4 a4 4 0 1 1-4 4 a4 4 0 1 0-4-4 Z"],
    alias: ["endless", "math"],
  },

  // ── tech ─────────────────────────────────────────────────────────────────
  {
    key: "cpu",
    labelKey: "deckIcon.cpu",
    category: "tech",
    paths: ["M6 6 H18 V18 H6 Z", "M9.5 9.5 H14.5 V14.5 H9.5 Z", "M9 2.5 V6", "M15 2.5 V6", "M9 18 V21.5", "M15 18 V21.5", "M2.5 9 H6", "M2.5 15 H6", "M18 9 H21.5", "M18 15 H21.5"],
    alias: ["processor", "chip", "compute"],
  },
  {
    key: "server",
    labelKey: "deckIcon.server",
    category: "tech",
    paths: ["M3 4 H21 V9.5 H3 Z", "M3 14.5 H21 V20 H3 Z", "M6.5 6.7 V6.8", "M6.5 17.2 V17.3"],
    alias: ["host", "machine", "cluster", "hpc"],
  },
  {
    key: "cloud",
    labelKey: "deckIcon.cloud",
    category: "tech",
    paths: ["M7 19 A4.75 4.75 0 0 1 7.4 9.5 A6.25 6.25 0 0 1 19 11 A4 4 0 0 1 18 19 Z"],
    alias: ["remote", "sync"],
  },
  {
    key: "wifi",
    labelKey: "deckIcon.wifi",
    category: "tech",
    paths: ["M2.5 9 A14 14 0 0 1 21.5 9", "M6.5 13 A8.5 8.5 0 0 1 17.5 13", "M10 16.8 A3.5 3.5 0 0 1 14 16.8", "M12 20.5 V20.6"],
    alias: ["network", "signal", "wireless"],
  },
  {
    key: "terminal",
    labelKey: "deckIcon.terminal",
    category: "tech",
    paths: ["M3 4.5 H21 V19.5 H3 Z", "M7 9.5 L10.5 12.5 L7 15.5", "M12.5 15.5 H17"],
    alias: ["shell", "console", "command"],
  },
  {
    key: "code",
    labelKey: "deckIcon.code",
    category: "tech",
    paths: ["M9 7.5 L4 12 L9 16.5", "M15 7.5 L20 12 L15 16.5", "M13.5 4.5 L10.5 19.5"],
    alias: ["dev", "program", "source"],
  },
  {
    key: "git-branch",
    labelKey: "deckIcon.git-branch",
    category: "tech",
    paths: [circle(7, 6, 2.5), circle(7, 18, 2.5), circle(17, 8.5, 2.5), "M7 8.5 V15.5", "M17 11 a6 6 0 0 1-6 6 H7"],
    alias: ["git", "fork", "version"],
  },
  {
    key: "network",
    labelKey: "deckIcon.network",
    category: "tech",
    paths: [circle(12, 5, 2.5), circle(5, 19, 2.5), circle(19, 19, 2.5), "M10.5 7.2 L6.4 16.8", "M13.5 7.2 L17.6 16.8", "M7.5 19 H16.5"],
    alias: ["graph", "nodes", "topology"],
  },
  {
    key: "monitor",
    labelKey: "deckIcon.monitor",
    category: "tech",
    paths: ["M3 4 H21 V16 H3 Z", "M9 20 H15", "M12 16 V20"],
    alias: ["screen", "display", "desktop"],
  },

  // ── people ───────────────────────────────────────────────────────────────
  {
    key: "user",
    labelKey: "deckIcon.user",
    category: "people",
    paths: [circle(12, 8, 4), "M4 21 a8 8 0 0 1 16 0"],
    alias: ["person", "profile", "account"],
  },
  {
    key: "users",
    labelKey: "deckIcon.users",
    category: "people",
    paths: [circle(9, 8, 3.5), "M2 21 a7 7 0 0 1 14 0", "M16 5 a3.5 3.5 0 0 1 0 7", "M17 14.5 a7 7 0 0 1 5 6.5"],
    alias: ["group", "team", "audience"],
  },
  {
    key: "speech",
    labelKey: "deckIcon.speech",
    category: "people",
    paths: ["M4 4 H20 V16 H11 L6.5 20 V16 H4 Z"],
    alias: ["comment", "chat", "quote", "bubble"],
  },
];

/** Directions generated from a single base glyph, by rotation. */
const DIRECTIONS: ReadonlyArray<readonly [string, number]> = [
  ["right", 0],
  ["down", 90],
  ["left", 180],
  ["up", 270],
];

/** Base glyphs that point right and should get all four directions. */
const DIRECTIONAL = new Set(["arrow", "chevron"]);

function buildLibrary(): IconDef[] {
  const out: IconDef[] = [];
  for (const def of BASE) {
    if (!DIRECTIONAL.has(def.key)) {
      out.push(def);
      continue;
    }
    for (const [name, deg] of DIRECTIONS) {
      out.push({
        ...def,
        key: `${def.key}-${name}`,
        directionKey: `deckIcon.dir.${name}` as TranslationKey,
        ...(deg ? { rotate: deg } : {}),
        alias: [...(def.alias ?? []), name],
      });
    }
    // A diagonal, which people reach for constantly and no rotation of the four
    // cardinals provides.
    if (def.key === "arrow") {
      out.push({
        ...def,
        key: "arrow-up-right",
        labelKey: "deckIcon.arrow-up-right",
        rotate: 315,
        alias: ["diagonal"],
      });
    }
  }
  return out;
}

/** Every icon, in display order. */
export const ICONS: readonly IconDef[] = buildLibrary();

const BY_KEY = new Map(ICONS.map((i) => [i.key, i]));

export function iconByKey(key: string): IconDef | undefined {
  return BY_KEY.get(key);
}

export const ICON_CATEGORIES: ReadonlyArray<{ id: IconCategory; labelKey: TranslationKey }> = [
  { id: "arrows", labelKey: "deckIcon.cat.arrows" },
  { id: "shapes", labelKey: "deckIcon.cat.shapes" },
  { id: "ui", labelKey: "deckIcon.cat.ui" },
  { id: "media", labelKey: "deckIcon.cat.media" },
  { id: "files", labelKey: "deckIcon.cat.files" },
  { id: "science", labelKey: "deckIcon.cat.science" },
  { id: "tech", labelKey: "deckIcon.cat.tech" },
  { id: "people", labelKey: "deckIcon.cat.people" },
];

/** The `useT()` translator, passed in rather than read from a store — these are
 *  pure functions the picker calls while rendering. */
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The icon's caption in the reader's language. A generated directional variant
 *  composes its base name with the direction word instead of concatenating two
 *  raw strings, which only reads correctly in English. */
export function iconLabel(def: IconDef, t: Translate): string {
  const base = t(def.labelKey);
  return def.directionKey
    ? t("deckIcon.directional", { icon: base, direction: t(def.directionKey) })
    : base;
}

/**
 * Search by key, label and alias. Substring rather than fuzzy: a fuzzy
 * subsequence match over ~80 short labels returns nearly everything for any
 * two-letter query, which is worse than no search at all.
 *
 * `t` resolves the labels, so a query matches the names actually on screen; the
 * `key` and `alias` fields stay English/technical and match in every language.
 */
export function searchIcons(
  query: string,
  t: Translate,
  category?: IconCategory,
): readonly IconDef[] {
  const q = query.trim().toLowerCase();
  const pool = category ? ICONS.filter((i) => i.category === category) : ICONS;
  if (!q) return pool;
  const scored: Array<{ def: IconDef; rank: number }> = [];
  for (const def of pool) {
    const label = iconLabel(def, t).toLowerCase();
    const key = def.key.toLowerCase();
    if (label.startsWith(q) || key.startsWith(q)) scored.push({ def, rank: 0 });
    else if (label.includes(q) || key.includes(q)) scored.push({ def, rank: 1 });
    else if (def.alias?.some((a) => a.includes(q))) scored.push({ def, rank: 2 });
  }
  return scored.sort((a, b) => a.rank - b.rank).map((s) => s.def);
}

/** The 24×24 box every path is authored in. */
export const ICON_VIEWBOX = 24;
