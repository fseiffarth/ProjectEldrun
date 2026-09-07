/**
 * The Markdown relationship graph (opt-in behind the `md_graph` experimental
 * flag): pure logic for extracting local-file link targets from markdown
 * source, crawling the link graph breadth-first from one starting document, and
 * laying the result out on concentric depth rings.
 *
 * Kept free of React and Tauri so the whole pipeline is unit-testable
 * (`src/__tests__/MdGraph.test.ts`); the component
 * (`components/embed/MdGraphView.tsx`) supplies the scoped file reads and the
 * SVG. File reads go through the caller-provided `readText`, so the graph
 * respects the same project-scope confinement every viewer read does — the
 * crawl can name a path outside the project, but the read for it fails and the
 * node simply renders as unreadable.
 */

import { isLocalHref, splitLineHint } from "./markdown";
import { dirname, normalizePath, resolvePath, basename } from "../paths";

export interface MdGraphNode {
  /** Absolute, normalised path — the node's identity. */
  path: string;
  /** Display label: the file's basename. */
  label: string;
  /** `md` documents are crawled; `file` targets are leaves; `missing` is an
   *  md target whose read failed (deleted, outside the scope, or a typo'd
   *  link — exactly the finding a link map is for). */
  kind: "md" | "file" | "missing";
  /** BFS depth from the start document (0 = the document itself). */
  depth: number;
}

export interface MdGraphEdge {
  from: string;
  to: string;
}

export interface MdGraph {
  start: string;
  nodes: MdGraphNode[];
  edges: MdGraphEdge[];
  /** True when the node cap stopped the crawl before it ran out of links. */
  truncated: boolean;
}

/** Extensions the crawl treats as markdown (read + parsed for further links). */
const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

export function isMdPath(path: string): boolean {
  return MD_EXT_RE.test(path);
}

/**
 * The local-file link targets of one markdown document, in order of first
 * appearance, deduplicated, fragments/queries stripped. Covers inline links
 * `[label](target)` and images `![alt](target)`; external URLs, `mailto:`,
 * pure `#anchor` links and other explicit schemes are excluded via the
 * renderer's own `isLocalHref` classification. Fenced code blocks and inline
 * code spans are skipped with the same fence bookkeeping the renderer uses, so
 * a link shown as code text never becomes a graph edge.
 */
export function extractLocalLinkTargets(src: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of src.split("\n")) {
    const fenceM = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceM) {
      const marker = fenceM[1][0];
      if (fence == null) fence = marker;
      else if (marker === fence && new RegExp(`^\\s*\\${marker}{3,}\\s*$`).test(line))
        fence = null;
      continue;
    }
    if (fence != null) continue;
    // Drop inline code spans so `[x](y)` inside backticks is not a link.
    const text = line.replace(/`[^`]+`/g, "");
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      let target = m[1].trim();
      if (!target || !isLocalHref(target)) continue;
      target = splitLineHint(target).href;
      target = target.replace(/[?#].*$/, "");
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep the raw target */
      }
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/**
 * Crawl the link graph breadth-first from `startPath`. `readText` resolves a
 * path to its contents, or null when it cannot be read (missing file, outside
 * the confinement scope, binary). Only markdown files are read and expanded;
 * every other linked file is a leaf. Bounded by `maxNodes` so a doc tree that
 * links a whole repository cannot queue thousands of SFTP reads — the graph
 * reports `truncated` instead.
 */
export async function buildMdGraph(
  startPath: string,
  readText: (path: string) => Promise<string | null>,
  opts: { maxNodes?: number } = {},
): Promise<MdGraph> {
  const maxNodes = opts.maxNodes ?? 120;
  const start = normalizePath(startPath);
  const nodes = new Map<string, MdGraphNode>();
  const edges: MdGraphEdge[] = [];
  const edgeSeen = new Set<string>();
  let truncated = false;

  nodes.set(start, {
    path: start,
    label: basename(start) || start,
    kind: "md",
    depth: 0,
  });
  const queue: string[] = [start];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = nodes.get(cur)!;
    const text = await readText(cur);
    if (text == null) {
      // The start document itself is being viewed, so an unreadable start is a
      // transient error, not a missing link target — leave it `md`.
      if (cur !== start) node.kind = "missing";
      continue;
    }
    const baseDir = dirname(cur) || "/";
    for (const target of extractLocalLinkTargets(text)) {
      const abs = resolvePath(baseDir, target);
      if (abs === cur) continue; // self-link: nothing to navigate to
      if (!nodes.has(abs)) {
        if (nodes.size >= maxNodes) {
          truncated = true;
          continue; // skip the edge too — an edge to a node not drawn is noise
        }
        const md = isMdPath(abs);
        nodes.set(abs, {
          path: abs,
          label: basename(abs) || abs,
          kind: md ? "md" : "file",
          depth: node.depth + 1,
        });
        if (md) queue.push(abs);
      }
      const key = `${cur}\u0000${abs}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({ from: cur, to: abs });
      }
    }
  }

  return { start, nodes: [...nodes.values()], edges, truncated };
}

export interface MdGraphLayout {
  /** Node path → position, in a coordinate system with (0,0) at the top-left
   *  and every node at least `pad` away from the edges. */
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * Deterministic radial layout: the start document sits at the center and each
 * BFS depth occupies a ring around it. Within a ring, nodes are sorted by their
 * first parent's angle (then label, for a stable tiebreak) and spaced evenly,
 * which keeps a file near the document that links it without needing an
 * iterative force simulation. A crowded ring pushes its radius outward so
 * labels keep a minimum arc spacing.
 */
export function layoutMdGraph(
  graph: MdGraph,
  opts: { ringGap?: number; minSpacing?: number; pad?: number } = {},
): MdGraphLayout {
  const ringGap = opts.ringGap ?? 170;
  const minSpacing = opts.minSpacing ?? 110;
  const pad = opts.pad ?? 110;

  const byDepth = new Map<number, MdGraphNode[]>();
  for (const n of graph.nodes) {
    const list = byDepth.get(n.depth) ?? [];
    list.push(n);
    byDepth.set(n.depth, list);
  }
  const firstParent = new Map<string, string>();
  for (const e of graph.edges) {
    if (!firstParent.has(e.to)) firstParent.set(e.to, e.from);
  }

  const angle = new Map<string, number>();
  const polar = new Map<string, { r: number; a: number }>();
  polar.set(graph.start, { r: 0, a: 0 });
  angle.set(graph.start, 0);

  const depths = [...byDepth.keys()].filter((d) => d > 0).sort((a, b) => a - b);
  let radius = 0;
  for (const d of depths) {
    const ring = byDepth.get(d)!;
    // Enough radius for the ring's population, and always outside the last ring.
    radius = Math.max(radius + ringGap, (ring.length * minSpacing) / (2 * Math.PI));
    const sorted = [...ring].sort((a, b) => {
      const pa = angle.get(firstParent.get(a.path) ?? "") ?? 0;
      const pb = angle.get(firstParent.get(b.path) ?? "") ?? 0;
      if (pa !== pb) return pa - pb;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
    sorted.forEach((n, i) => {
      const a = (2 * Math.PI * i) / sorted.length;
      angle.set(n.path, a);
      polar.set(n.path, { r: radius, a });
    });
  }

  // Convert to cartesian and shift into a positive box.
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  const raw = new Map<string, { x: number; y: number }>();
  for (const [path, { r, a }] of polar) {
    const x = r * Math.cos(a - Math.PI / 2);
    const y = r * Math.sin(a - Math.PI / 2);
    raw.set(path, { x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [path, { x, y }] of raw) {
    positions.set(path, { x: x - minX + pad, y: y - minY + pad });
  }
  return {
    positions,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}
