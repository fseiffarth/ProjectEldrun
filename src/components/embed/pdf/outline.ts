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
 * A resolved destination: which page, and where on it.
 *
 * `top` is the destination's own y anchor in **PDF user space** (bottom-left
 * origin, unrotated) — the number the file itself carries — or null when the
 * destination names no position (a whole-page `/Fit`, or an `/XYZ` that left the
 * coordinate as "unchanged"). Converting it to a screen offset needs the target
 * page's viewport, which only the caller that is about to scroll knows the
 * rotation for, so it is deliberately left in the file's own units here.
 */
export interface PdfDest {
  /** 1-based FILE page (the numbering `PageRef.page` uses). */
  page: number;
  top: number | null;
}

/**
 * The y anchor an explicit destination array names, in PDF user space.
 *
 * The array is `[pageRef, {name}, …args]` and each destination *type* spends its
 * args differently — `/XYZ left top zoom`, `/FitH top`, `/FitR left bottom right
 * top` — so the slot the top sits in is chosen by the name. A type that names no
 * position (`/Fit`, `/FitB`), or an argument the file left as `null` (PDF's
 * "leave this coordinate unchanged"), yields null. Pure.
 */
export function destTop(explicit: unknown[]): number | null {
  const name = (explicit[1] as { name?: string } | undefined)?.name;
  const at = (i: number) => (typeof explicit[i] === "number" ? (explicit[i] as number) : null);
  switch (name) {
    case "XYZ":
      return at(3);
    case "FitH":
    case "FitBH":
      return at(2);
    case "FitR":
      return at(5);
    default:
      return null;
  }
}

/**
 * Resolve one destination — the app's ONE destination resolver, shared by the
 * contents sidebar and the page links, so a chapter and a `\ref` to the same
 * anchor can never disagree about where it is.
 *
 * A named destination (a string) is looked up first; an explicit array carries
 * the page reference in slot 0 — usually a `{num, gen}` ref (resolved via
 * `getPageIndex`), occasionally already a 0-based page index.
 */
export async function resolveDest(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<PdfDest | null> {
  let explicit: unknown = dest;
  if (typeof dest === "string") {
    try {
      explicit = await doc.getDestination(dest);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const top = destTop(explicit);
  const ref = explicit[0];
  if (typeof ref === "number") return { page: ref + 1, top }; // already a 0-based index
  try {
    const idx = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return { page: idx + 1, top };
  } catch {
    return null;
  }
}

/** Resolve one outline destination to a 1-based page number. */
async function destToPage(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  return (await resolveDest(doc, dest))?.page ?? null;
}

/** Resolve one raw item and its descendants into an {@link OutlineNode}. */
async function resolveItem(
  doc: PDFDocumentProxy,
  raw: RawOutlineItem,
  id: string,
  untitledLabel: string,
): Promise<OutlineNode> {
  const [page, children] = await Promise.all([
    destToPage(doc, raw.dest ?? null),
    resolveItems(doc, raw.items ?? [], id, untitledLabel),
  ]);
  return { id, title: raw.title || untitledLabel, page, children };
}

/** Resolve a sibling list, giving each child a path-derived id. */
async function resolveItems(
  doc: PDFDocumentProxy,
  items: RawOutlineItem[],
  parentId: string,
  untitledLabel: string,
): Promise<OutlineNode[]> {
  return Promise.all(
    items.map((it, i) => resolveItem(doc, it, parentId ? `${parentId}.${i}` : String(i), untitledLabel)),
  );
}

/**
 * Load the document's outline as a resolved, jump-ready tree. Returns `[]` when
 * the PDF carries no outline (many scanned or exported PDFs don't).
 *
 * `untitledLabel` names a bookmark whose author left its title blank — pass the
 * translated string; it defaults to the English literal for callers (tests) that
 * don't have a translator in scope.
 */
export async function loadOutline(
  doc: PDFDocumentProxy,
  untitledLabel = "Untitled",
): Promise<OutlineNode[]> {
  const raw = (await doc.getOutline()) as RawOutlineItem[] | null;
  if (!raw || raw.length === 0) return [];
  return resolveItems(doc, raw, "", untitledLabel);
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

/**
 * Does this embedded outline carry real navigation, or is it a lone bookmark?
 *
 * Some LaTeX/`hyperref` templates ship a bookmark tree of exactly one entry — the
 * paper's title, pointing at page 1 — while the actual section structure lives
 * only in the typeset text. Rendered verbatim, the contents sidebar then shows
 * nothing but that title, which reads as broken. Such an outline is worthless for
 * navigation, so the viewer treats it as *absent* and falls back to the font-size
 * heading scan (which does find the sections). A genuine contents has at least two
 * entries, or one entry with children; a single childless node is the degenerate
 * case this rules out.
 */
export function outlineIsNavigable(nodes: OutlineNode[]): boolean {
  return flattenOutline(nodes).length >= 2;
}
