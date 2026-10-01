/**
 * The markup layer: what the reader drew over a PDF's pages or a picture,
 * as vectors in each page's own units (`docs/mobile_pdf_markup_plan.md`
 * §2.1). A PDF page's units are its points as displayed — after its
 * `/Rotate`, origin top left; a picture's are its pixels. The same numbers
 * draw on the phone (`rasterize.ts`) and bake into the desktop's marked copy
 * (`markup.rs`), whose wire shape this mirrors.
 *
 * Everything here is pure: the view keeps a `History` and replaces it.
 */

export type MarkColor = "red" | "blue" | "black" | "yellow";
export const MARK_COLORS: readonly MarkColor[] = ["red", "blue", "black", "yellow"];

/** A pen stroke: `[x, y, pressure]` samples and its base width. */
export type InkMark = { kind: "ink"; color: MarkColor; width: number; points: [number, number, number][] };
/** A highlighter box: `[x, y, width, height]`. */
export type BoxMark = { kind: "box"; color: MarkColor; rect: [number, number, number, number] };
/** A typed note, anchored at its top-left corner; `\n` breaks lines. */
export type TextMark = { kind: "text"; color: MarkColor; at: [number, number]; size: number; text: string };
export type Mark = InkMark | BoxMark | TextMark;

/** One page's marks and the size they are measured in. */
export type PageLayer = { size: [number, number]; marks: Mark[] };
/** Every marked page, by 1-based page number. */
export type Layer = { pages: Record<number, PageLayer> };

export const EMPTY_LAYER: Layer = { pages: {} };

/** The desktop's ceilings (`markup.rs`), checked before a mark is added so a
 * layer the phone holds is always one the desktop accepts. */
export const LIMITS = { marks: 5_000, points: 200_000, pageText: 2_000 } as const;

/** Text notes' line height and assumed character width, in multiples of the
 * font size — the desktop sizes the note's box the same way. */
export const LEADING = 1.2;
export const CHAR_WIDTH = 0.72;

/** A stroke's width at one sample: `0.5` pressure (a finger, a mouse) draws
 * the base width. The desktop's `markup::ink_width` is the same formula. */
export function inkWidth(base: number, pressure: number): number {
  return base * (0.3 + 1.4 * Math.min(1, Math.max(0, pressure)));
}

/** A coordinate as stored: a tenth of a unit is finer than any pen. */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Keeps a point on the page — a stroke that runs off the edge ends there. */
export function clampToPage(x: number, y: number, size: [number, number]): [number, number] {
  return [Math.min(size[0], Math.max(0, x)), Math.min(size[1], Math.max(0, y))];
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker on a stroke's samples, keeping each kept sample's
 * pressure: handwriting stays handwriting at a fraction of the points. */
export function simplify(points: [number, number, number][], tolerance: number): [number, number, number][] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment([points[i][0], points[i][1]], [points[first][0], points[first][1]], [points[last][0], points[last][1]]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at > 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A finished stroke as stored: rounded, simplified, on the page. */
export function finishStroke(mark: InkMark, size: [number, number]): InkMark {
  const placed = mark.points.map(([x, y, p]): [number, number, number] => {
    const [cx, cy] = clampToPage(x, y, size);
    return [round(cx), round(cy), Math.round(p * 100) / 100];
  });
  // Half the base width is below what the eye tells apart at that width.
  return { ...mark, points: simplify(placed, Math.max(0.15, mark.width * 0.15)) };
}

/** The box a text note covers — the same estimate the desktop sizes its
 * annotation by. */
export function textBox(mark: TextMark): [number, number, number, number] {
  const lines = mark.text.split("\n");
  const widest = Math.max(1, ...lines.map((line) => [...line].length));
  return [mark.at[0], mark.at[1], widest * mark.size * CHAR_WIDTH, lines.length * mark.size * LEADING];
}

export function markCount(layer: Layer): { marks: number; points: number } {
  let marks = 0;
  let points = 0;
  for (const page of Object.values(layer.pages)) {
    marks += page.marks.length;
    for (const mark of page.marks) if (mark.kind === "ink") points += mark.points.length;
  }
  return { marks, points };
}

function pageText(page: PageLayer | undefined): number {
  return (page?.marks ?? []).reduce((sum, mark) => sum + (mark.kind === "text" ? [...mark.text].length : 0), 0);
}

/** Whether `mark` still fits under the desktop's ceilings. */
export function canAdd(layer: Layer, n: number, mark: Mark): boolean {
  const { marks, points } = markCount(layer);
  if (marks + 1 > LIMITS.marks) return false;
  if (mark.kind === "ink" && points + mark.points.length > LIMITS.points) return false;
  if (mark.kind === "text" && pageText(layer.pages[n]) + [...mark.text].length > LIMITS.pageText) return false;
  return true;
}

/** Whether the note at `index` on page `n` may become `mark` — an edited
 * note counts against the page's text in place of the one it replaces. */
export function canReplace(layer: Layer, n: number, index: number, mark: Mark): boolean {
  if (mark.kind !== "text") return true;
  const page = layer.pages[n];
  const replaced = page?.marks[index];
  const before = pageText(page) - (replaced?.kind === "text" ? [...replaced.text].length : 0);
  return before + [...mark.text].length <= LIMITS.pageText;
}

export function addMark(layer: Layer, n: number, size: [number, number], mark: Mark): Layer {
  const page = layer.pages[n] ?? { size, marks: [] };
  return { pages: { ...layer.pages, [n]: { size: page.size, marks: [...page.marks, mark] } } };
}

/** Replaces the mark at `index` on page `n` — an edited note. An empty
 * replacement removes it. */
export function replaceMark(layer: Layer, n: number, index: number, mark: Mark | null): Layer {
  const page = layer.pages[n];
  if (!page || index < 0 || index >= page.marks.length) return layer;
  const marks = page.marks.slice();
  if (mark) marks.splice(index, 1, mark);
  else marks.splice(index, 1);
  return withPage(layer, n, { ...page, marks });
}

function withPage(layer: Layer, n: number, page: PageLayer): Layer {
  const pages = { ...layer.pages };
  if (page.marks.length) pages[n] = page;
  else delete pages[n];
  return { pages };
}

/** Whether a mark lies within `radius` of `(x, y)`. */
export function touches(mark: Mark, x: number, y: number, radius: number): boolean {
  if (mark.kind === "ink") {
    const reach = radius + inkWidth(mark.width, 1) / 2;
    if (mark.points.length === 1) return Math.hypot(mark.points[0][0] - x, mark.points[0][1] - y) <= reach;
    for (let i = 1; i < mark.points.length; i++) {
      const a = mark.points[i - 1];
      const b = mark.points[i];
      if (distanceToSegment([x, y], [a[0], a[1]], [b[0], b[1]]) <= reach) return true;
    }
    return false;
  }
  const [bx, by, bw, bh] = mark.kind === "box" ? mark.rect : textBox(mark);
  return x >= bx - radius && x <= bx + bw + radius && y >= by - radius && y <= by + bh + radius;
}

/** The eraser: every whole mark on page `n` it touches goes. */
export function eraseAt(layer: Layer, n: number, x: number, y: number, radius: number): Layer {
  const page = layer.pages[n];
  if (!page) return layer;
  const marks = page.marks.filter((mark) => !touches(mark, x, y, radius));
  return marks.length === page.marks.length ? layer : withPage(layer, n, { ...page, marks });
}

export function clearPage(layer: Layer, n: number): Layer {
  if (!layer.pages[n]) return layer;
  return withPage(layer, n, { ...layer.pages[n], marks: [] });
}

export function isEmpty(layer: Layer): boolean {
  return Object.values(layer.pages).every((page) => page.marks.length === 0);
}

/** The marked pages' numbers, in order. */
export function markedPages(layer: Layer): number[] {
  return Object.entries(layer.pages)
    .filter(([, page]) => page.marks.length > 0)
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/** Undo and redo over whole layers: each change keeps the one before it. The
 * marks themselves are shared between snapshots, never copied. */
export type History = { past: Layer[]; present: Layer; future: Layer[] };
const MAX_UNDO = 200;

export function startHistory(layer: Layer = EMPTY_LAYER): History {
  return { past: [], present: layer, future: [] };
}

export function commit(history: History, next: Layer): History {
  if (next === history.present) return history;
  return { past: [...history.past, history.present].slice(-MAX_UNDO), present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Whether a stored value is a layer this build can draw — storage is the
 * phone's own, but it outlives builds and can be anything after a bad write. */
export function isLayer(value: unknown): value is Layer {
  if (!value || typeof value !== "object") return false;
  const pages = (value as { pages?: unknown }).pages;
  if (!pages || typeof pages !== "object") return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const color = (v: unknown) => MARK_COLORS.includes(v as MarkColor);
  return Object.entries(pages as Record<string, unknown>).every(([n, page]) => {
    if (!/^[1-9]\d*$/.test(n) || !page || typeof page !== "object") return false;
    const { size, marks } = page as { size?: unknown; marks?: unknown };
    if (!Array.isArray(size) || size.length !== 2 || !size.every(num) || !Array.isArray(marks)) return false;
    return marks.every((mark: unknown) => {
      if (!mark || typeof mark !== "object") return false;
      const m = mark as Record<string, unknown>;
      if (!color(m.color)) return false;
      if (m.kind === "ink") return num(m.width) && Array.isArray(m.points) && m.points.length > 0
        && m.points.every((p: unknown) => Array.isArray(p) && p.length === 3 && p.every(num));
      if (m.kind === "box") return Array.isArray(m.rect) && m.rect.length === 4 && m.rect.every(num);
      if (m.kind === "text") return Array.isArray(m.at) && m.at.length === 2 && m.at.every(num) && num(m.size) && typeof m.text === "string";
      return false;
    });
  });
}
