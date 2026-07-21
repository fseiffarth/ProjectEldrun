/**
 * The PDF's embedded outline (its bookmarks / table of contents) resolved to a
 * jump-ready tree — the "chapters" the contents sidebar renders.
 *
 * A PDF author ships the outline as a tree of items, each pointing at a
 * *destination* rather than a plain page number: a named string, or an explicit
 * array whose first element is a page reference. `loadOutline` walks that tree
 * and resolves every destination to a 1-based **file** page (the same numbering
 * `PageRef.page` uses), so the viewer can map it to whichever sheet is currently
 * showing that page — even after pages are reordered, deleted or merged.
 *
 * Pure and best-effort: an item whose destination can't be resolved keeps a
 * `page` of `null` (rendered but not clickable) rather than failing the load, and
 * a document with no outline simply yields an empty list.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

/** One resolved outline entry (a chapter/section/subsection). */
export interface OutlineNode {
  /** Stable id for React keys and collapse state (its path through the tree). */
  id: string;
  title: string;
  /** 1-based file page this entry jumps to, or null if it couldn't resolve. */
  page: number | null;
  children: OutlineNode[];
}

/** The raw shape pdf.js hands back from `getOutline()` (the fields we use). */
interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/**
 * Resolve one outline destination to a 1-based page number.
 *
 * A named destination (a string) is looked up first; an explicit array carries
 * the page reference in slot 0 — usually a `{num, gen}` ref (resolved via
 * `getPageIndex`), occasionally already a 0-based page index.
 */
async function destToPage(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  let explicit: unknown = dest;
  if (typeof dest === "string") {
    explicit = await doc.getDestination(dest);
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const ref = explicit[0];
  if (typeof ref === "number") return ref + 1; // already a 0-based page index
  try {
    const idx = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return idx + 1;
  } catch {
    return null;
  }
}

/** Resolve one raw item and its descendants into an {@link OutlineNode}. */
async function resolveItem(
  doc: PDFDocumentProxy,
  raw: RawOutlineItem,
  id: string,
): Promise<OutlineNode> {
  const [page, children] = await Promise.all([
    destToPage(doc, raw.dest ?? null),
    resolveItems(doc, raw.items ?? [], id),
  ]);
  return { id, title: raw.title || "Untitled", page, children };
}

/** Resolve a sibling list, giving each child a path-derived id. */
async function resolveItems(
  doc: PDFDocumentProxy,
  items: RawOutlineItem[],
  parentId: string,
): Promise<OutlineNode[]> {
  return Promise.all(
    items.map((it, i) => resolveItem(doc, it, parentId ? `${parentId}.${i}` : String(i))),
  );
}

/**
 * Load the document's outline as a resolved, jump-ready tree. Returns `[]` when
 * the PDF carries no outline (many scanned or exported PDFs don't).
 */
export async function loadOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = (await doc.getOutline()) as RawOutlineItem[] | null;
  if (!raw || raw.length === 0) return [];
  return resolveItems(doc, raw, "");
}

/**
 * One positioned text run pulled from a page, for the heading fallback. `size` is
 * the run's font size (em) in big points; `y` is its top in a top-left viewport,
 * so smaller `y` is higher on the page (reading order). Page is 1-based.
 */
export interface HeadingRun {
  str: string;
  size: number;
  page: number;
  x: number;
  y: number;
}

/** Round a font size to the nearest 0.5 so float jitter doesn't split a size. */
const roundSize = (n: number) => Math.round(n * 2) / 2;

/**
 * Best-effort "chapters" for a PDF that ships **no** embedded outline: infer a
 * heading tree from the text's own typography.
 *
 * The idea is that a heading is set distinctly larger than body text. So: find
 * the **body** size (the size covering the most characters), group runs into
 * lines, keep the lines set clearly larger than body, drop **running headers**
 * (the same text repeated across many pages), and nest what's left by size
 * (largest size = top level). It is a heuristic, not the author's intent — so it
 * is only ever used when {@link loadOutline} came back empty, and the sidebar
 * labels it as derived.
 */
export function detectHeadings(runs: HeadingRun[]): OutlineNode[] {
  const clean = runs.filter((r) => r.str && r.str.trim().length > 0);
  if (clean.length === 0) return [];

  // Body size = the size covering the most characters (a char-weighted mode).
  const charBySize = new Map<number, number>();
  for (const r of clean) {
    const s = roundSize(r.size);
    charBySize.set(s, (charBySize.get(s) ?? 0) + r.str.trim().length);
  }
  let body = 0;
  let bodyChars = -1;
  for (const [s, c] of charBySize) {
    if (c > bodyChars) {
      bodyChars = c;
      body = s;
    }
  }
  if (body <= 0) return [];

  // Group runs into lines (same page, near-equal baseline) in reading order.
  const sorted = [...clean].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  interface Line {
    page: number;
    y: number;
    text: string;
    size: number;
  }
  const lines: Line[] = [];
  let cur: { page: number; y: number; parts: HeadingRun[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const parts = [...cur.parts].sort((a, b) => a.x - b.x);
    const text = parts
      .map((p) => p.str)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    // Dominant size on the line = the size covering the most of its characters.
    const bySize = new Map<number, number>();
    for (const p of parts) {
      const s = roundSize(p.size);
      bySize.set(s, (bySize.get(s) ?? 0) + p.str.trim().length);
    }
    let size = body;
    let best = -1;
    for (const [s, c] of bySize) {
      if (c > best) {
        best = c;
        size = s;
      }
    }
    if (text) lines.push({ page: cur.page, y: cur.y, text, size });
    cur = null;
  };
  for (const r of sorted) {
    const tol = Math.max(2, roundSize(r.size) * 0.4);
    if (cur && r.page === cur.page && Math.abs(r.y - cur.y) <= tol) {
      cur.parts.push(r);
    } else {
      flush();
      cur = { page: r.page, y: r.y, parts: [r] };
    }
  }
  flush();

  // Candidates: distinctly larger than body, real letters, not a whole paragraph.
  const threshold = body * 1.2;
  const candidates = lines.filter(
    (l) => l.size >= threshold && l.text.length >= 2 && l.text.length <= 160 && /\p{L}/u.test(l.text),
  );
  if (candidates.length === 0) return [];

  // Drop running headers/footers: the same heading text on more than 3 pages is
  // page furniture (a chapter title repeated in the header), not a chapter mark.
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const pagesByText = new Map<string, Set<number>>();
  for (const l of candidates) {
    const k = norm(l.text);
    let set = pagesByText.get(k);
    if (!set) pagesByText.set(k, (set = new Set()));
    set.add(l.page);
  }
  const headings = candidates.filter((l) => (pagesByText.get(norm(l.text))?.size ?? 0) <= 3);
  if (headings.length === 0) return [];

  // Level by size: the largest distinct heading size is the top level.
  const sizes = [...new Set(headings.map((h) => h.size))].sort((a, b) => b - a);
  const levelOf = (s: number) => sizes.indexOf(s);

  // Nest by level with a stack, in document order.
  const roots: OutlineNode[] = [];
  const stack: { node: OutlineNode; level: number }[] = [];
  let seq = 0;
  for (const h of headings) {
    const node: OutlineNode = { id: `h${seq++}`, title: h.text, page: h.page, children: [] };
    const level = levelOf(h.size);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ node, level });
  }
  return roots;
}

/**
 * Flatten a resolved outline into visit order, tagging each node with its depth
 * — used to decide which entry is "current" (the deepest one whose page is at or
 * before the page in view). Nodes with no resolved page are skipped.
 */
export function flattenOutline(nodes: OutlineNode[], depth = 0): { node: OutlineNode; depth: number }[] {
  const out: { node: OutlineNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length) out.push(...flattenOutline(node.children, depth + 1));
  }
  return out;
}
