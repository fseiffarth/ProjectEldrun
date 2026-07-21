/**
 * The PDF outline model (#pdf-outline) — the pure resolver that turns pdf.js's
 * raw bookmark tree into a jump-ready chapter tree.
 *
 * The load-bearing properties pinned here: destinations resolve to 1-based FILE
 * pages (named strings and explicit arrays alike); an unresolvable destination
 * degrades to a null page rather than failing the whole load; nesting and ids are
 * preserved; and a document with no outline yields an empty list.
 */
import { describe, it, expect } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  loadOutline,
  detectHeadings,
  flattenOutline,
  type OutlineNode,
  type HeadingRun,
} from "../components/embed/pdf/outline";

/**
 * A minimal fake pdf.js document: `getOutline` returns the given raw tree,
 * `getPageIndex` maps a fake `{num}` ref to a 0-based index (num → num), and
 * `getDestination` resolves a named string to an explicit dest array.
 */
function fakeDoc(
  outline: unknown,
  named: Record<string, unknown[]> = {},
): PDFDocumentProxy {
  return {
    getOutline: async () => outline,
    getDestination: async (name: string) => named[name] ?? null,
    getPageIndex: async (ref: { num?: number }) => {
      if (ref && typeof ref.num === "number") return ref.num;
      throw new Error("bad ref");
    },
  } as unknown as PDFDocumentProxy;
}

describe("loadOutline", () => {
  it("returns [] for a document with no outline", async () => {
    expect(await loadOutline(fakeDoc(null))).toEqual([]);
    expect(await loadOutline(fakeDoc([]))).toEqual([]);
  });

  it("resolves an explicit destination array to a 1-based page", async () => {
    const doc = fakeDoc([
      { title: "Chapter 1", dest: [{ num: 0 }, { name: "XYZ" }], items: [] },
      { title: "Chapter 2", dest: [{ num: 4 }, { name: "XYZ" }], items: [] },
    ]);
    const nodes = await loadOutline(doc);
    expect(nodes.map((n) => [n.title, n.page])).toEqual([
      ["Chapter 1", 1],
      ["Chapter 2", 5],
    ]);
  });

  it("resolves a named destination via getDestination", async () => {
    const doc = fakeDoc(
      [{ title: "Intro", dest: "intro-anchor", items: [] }],
      { "intro-anchor": [{ num: 2 }, { name: "Fit" }] },
    );
    const [node] = await loadOutline(doc);
    expect(node.page).toBe(3);
  });

  it("accepts a numeric page index in slot 0", async () => {
    const doc = fakeDoc([{ title: "Cover", dest: [3], items: [] }]);
    const [node] = await loadOutline(doc);
    expect(node.page).toBe(4);
  });

  it("keeps a node whose destination cannot resolve, with a null page", async () => {
    const doc = fakeDoc([
      { title: "Broken", dest: [{}, { name: "XYZ" }], items: [] },
      { title: "Missing name", dest: "not-in-map", items: [] },
      { title: "No dest", dest: null, items: [] },
    ]);
    const nodes = await loadOutline(doc);
    expect(nodes.map((n) => n.page)).toEqual([null, null, null]);
    expect(nodes.map((n) => n.title)).toEqual(["Broken", "Missing name", "No dest"]);
  });

  it("preserves nesting and assigns path-derived ids", async () => {
    const doc = fakeDoc([
      {
        title: "Part I",
        dest: [{ num: 0 }],
        items: [
          { title: "Section A", dest: [{ num: 1 }], items: [] },
          { title: "Section B", dest: [{ num: 2 }], items: [] },
        ],
      },
    ]);
    const [part] = await loadOutline(doc);
    expect(part.id).toBe("0");
    expect(part.children.map((c) => c.id)).toEqual(["0.0", "0.1"]);
    expect(part.children.map((c) => c.page)).toEqual([2, 3]);
  });

  it("falls back to 'Untitled' for a blank title", async () => {
    const doc = fakeDoc([{ title: "", dest: [{ num: 0 }], items: [] }]);
    const [node] = await loadOutline(doc);
    expect(node.title).toBe("Untitled");
  });
});

describe("detectHeadings (font-size fallback)", () => {
  // A page of body text at size 10, one run per line.
  const body = (page: number, lines: number, startY = 100): HeadingRun[] =>
    Array.from({ length: lines }, (_, i) => ({
      str: "the quick brown fox jumps over the lazy dog and runs on",
      size: 10,
      page,
      x: 50,
      y: startY + i * 12,
    }));

  const heading = (str: string, size: number, page: number, y: number): HeadingRun => ({
    str,
    size,
    page,
    x: 50,
    y,
  });

  it("returns [] with no runs, or when nothing beats body size", () => {
    expect(detectHeadings([])).toEqual([]);
    expect(detectHeadings(body(1, 20))).toEqual([]);
  });

  it("picks out a run set distinctly larger than body text", () => {
    const runs = [
      heading("Chapter One", 20, 1, 40),
      ...body(1, 20),
      heading("Chapter Two", 20, 5, 40),
      ...body(5, 20),
    ];
    const nodes = detectHeadings(runs);
    expect(nodes.map((n) => [n.title, n.page])).toEqual([
      ["Chapter One", 1],
      ["Chapter Two", 5],
    ]);
  });

  it("nests smaller headings under larger ones by size", () => {
    const runs = [
      heading("Part I", 22, 1, 40),
      heading("Section A", 16, 1, 80),
      heading("Section B", 16, 2, 40),
      heading("Part II", 22, 5, 40),
      ...body(1, 15),
      ...body(2, 15),
      ...body(5, 15),
    ];
    const nodes = detectHeadings(runs);
    expect(nodes.map((n) => n.title)).toEqual(["Part I", "Part II"]);
    expect(nodes[0].children.map((c) => [c.title, c.page])).toEqual([
      ["Section A", 1],
      ["Section B", 2],
    ]);
  });

  it("groups runs on the same line into one heading", () => {
    const runs = [
      heading("Chapter ", 20, 1, 40),
      { ...heading("One", 20, 1, 40), x: 140 },
      ...body(1, 20),
    ];
    expect(detectHeadings(runs).map((n) => n.title)).toEqual(["Chapter One"]);
  });

  it("drops running headers (same big text repeated across many pages)", () => {
    const runs: HeadingRun[] = [];
    // A running header appearing at the top of 8 pages, plus real body text.
    for (let p = 1; p <= 8; p++) {
      runs.push(heading("A Very Long Book Title", 14, p, 20));
      runs.push(...body(p, 20));
    }
    // One genuine chapter heading, on a single page.
    runs.push(heading("Real Chapter", 20, 3, 60));
    const nodes = detectHeadings(runs);
    expect(nodes.map((n) => n.title)).toEqual(["Real Chapter"]);
  });
});

describe("flattenOutline", () => {
  it("flattens in visit order with depths", () => {
    const tree: OutlineNode[] = [
      {
        id: "0",
        title: "A",
        page: 1,
        children: [{ id: "0.0", title: "A.1", page: 2, children: [] }],
      },
      { id: "1", title: "B", page: 5, children: [] },
    ];
    expect(flattenOutline(tree).map((e) => [e.node.title, e.depth])).toEqual([
      ["A", 0],
      ["A.1", 1],
      ["B", 0],
    ]);
  });
});
