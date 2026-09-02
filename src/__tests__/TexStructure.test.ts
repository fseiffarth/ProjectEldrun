/**
 * Tests for `gatherTexStructure` — the enumerator behind the TeX workspace's
 * left structure sidebar. It walks a main document's `\input`/`\include`/
 * `\subfile` children and its `\includegraphics` graphics into a tree, in
 * document order, each attributed to the section heading it sits under, bounded
 * and best-effort (a missing/unreadable file becomes a leaf, never an error).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { gatherTexStructure, texStructureParent, type TexFileNode } from "../lib/viewers/tex";

/** Drive `read_file_text` off a fixed file map; `list_dir` is unused here since
 *  every graphic below carries an explicit extension (resolved synchronously). */
function mockFiles(files: Record<string, string>) {
  mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => {
    if (cmd === "read_file_text") {
      const text = files[args.path!];
      return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
    }
    if (cmd === "list_dir") return Promise.reject(new Error("no dir listing in this test"));
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

/** Flatten every file node's path in document order for order assertions. */
function flatPaths(node: TexFileNode): string[] {
  return [node.path, ...node.children.flatMap(flatPaths)];
}

describe("gatherTexStructure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enumerates \\input/\\include/\\subfile children in document order", async () => {
    mockFiles({
      "/p/main.tex":
        "\\documentclass{article}\n" +
        "\\begin{document}\n" +
        "\\input{intro}\n" +
        "\\include{methods}\n" +
        "\\subfile{results}\n" +
        "\\end{document}\n",
      "/p/intro.tex": "hi",
      "/p/methods.tex": "hi",
      "/p/results.tex": "hi",
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.path).toBe("/p/main.tex");
    expect(root.children.map((c) => c.path)).toEqual([
      "/p/intro.tex",
      "/p/methods.tex",
      "/p/results.tex",
    ]);
  });

  it("records the line/column of each \\input and answers 'go up' with it (#tex-structure-up)", async () => {
    mockFiles({
      "/p/main.tex":
        "\\documentclass{article}\n" +
        "\\begin{document}\n" +
        "\\section{One}\n" +
        "  \\input{intro}\n" +
        "\\includegraphics[width=1cm]{fig.png}\n" +
        "\\input{outro} % \\input{intro} again — the first wins\n" +
        "\\end{document}\n",
      "/p/intro.tex": "\\input{deep}\n",
      "/p/deep.tex": "hi",
      "/p/outro.tex": "hi",
    });

    const structure = await gatherTexStructure("/p/main.tex", "proj");
    const { root } = structure;
    expect(root.line).toBeUndefined();
    expect(root.children.map((c) => [c.path, c.line, c.column])).toEqual([
      ["/p/intro.tex", 4, 3],
      ["/p/outro.tex", 6, 1],
    ]);
    expect(root.graphics.map((g) => [g.path, g.line, g.column])).toEqual([["/p/fig.png", 5, 1]]);
    // A nested child's position is in ITS parent, not the root.
    expect(root.children[0].children[0]).toMatchObject({ path: "/p/deep.tex", line: 1, column: 1 });

    expect(texStructureParent(structure, "/p/deep.tex")).toEqual({ path: "/p/intro.tex", line: 1, column: 1 });
    expect(texStructureParent(structure, "/p/outro.tex")).toEqual({ path: "/p/main.tex", line: 6, column: 1 });
    expect(texStructureParent(structure, "/p/fig.png")).toEqual({ path: "/p/main.tex", line: 5, column: 1 });
    // The root has nothing above it; an unlisted file is not in the tree.
    expect(texStructureParent(structure, "/p/main.tex")).toBeNull();
    expect(texStructureParent(structure, "/p/elsewhere.tex")).toBeNull();
  });

  it("gathers \\includegraphics graphics with the viewer they render in", async () => {
    mockFiles({
      "/p/main.tex":
        "\\includegraphics{fig/plot.png}\n\\includegraphics{diagram.pdf}\n",
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.graphics).toEqual([
      { path: "/p/fig/plot.png", label: "plot.png", viewer: "image", section: undefined, line: 1, column: 1 },
      { path: "/p/diagram.pdf", label: "diagram.pdf", viewer: "pdf", section: undefined, line: 2, column: 1 },
    ]);
  });

  it("attributes children and graphics to the nearest preceding section heading", async () => {
    mockFiles({
      "/p/main.tex":
        "\\section{Intro}\n" +
        "\\input{intro}\n" +
        "\\section{Results}\n" +
        "\\includegraphics{fig/plot.png}\n" +
        "\\input{results}\n",
      "/p/intro.tex": "hi",
      "/p/results.tex": "hi",
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    const [intro, results] = root.children;
    expect(intro.path).toBe("/p/intro.tex");
    expect(intro.section).toBe("Intro");
    expect(results.path).toBe("/p/results.tex");
    expect(results.section).toBe("Results");
    expect(root.graphics[0]).toMatchObject({ path: "/p/fig/plot.png", section: "Results" });
  });

  it("recurses into nested children (a child's own \\input)", async () => {
    mockFiles({
      "/p/main.tex": "\\input{chap}\n",
      "/p/chap.tex": "\\input{sub}\n",
      "/p/sub.tex": "leaf",
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(flatPaths(root)).toEqual(["/p/main.tex", "/p/chap.tex", "/p/sub.tex"]);
  });

  it("is best-effort: a missing/unreadable child becomes a leaf, not an error", async () => {
    mockFiles({
      "/p/main.tex": "\\input{present}\n\\input{gone}\n",
      "/p/present.tex": "\\includegraphics{ok.png}\n",
      // "/p/gone.tex" deliberately absent → read_file_text rejects.
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.children.map((c) => c.path)).toEqual(["/p/present.tex", "/p/gone.tex"]);
    const [present, gone] = root.children;
    expect(present.graphics.map((g) => g.path)).toEqual(["/p/ok.png"]);
    // The unreadable file is a childless/graphic-less leaf rather than throwing.
    expect(gone.children).toEqual([]);
    expect(gone.graphics).toEqual([]);
  });

  it("excludes a commented-out \\input/\\includegraphics from the sidebar", async () => {
    mockFiles({
      "/p/main.tex":
        "\\input{intro}\n" +
        "% \\input{oldstuff}\n" + // whole line commented
        "\\includegraphics{fig/plot.png} % keep\n" +
        "  % \\includegraphics{fig/stale.png}\n" + // indented comment
        "\\input{results}\n",
      "/p/intro.tex": "hi",
      "/p/oldstuff.tex": "should not be walked",
      "/p/results.tex": "hi",
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.children.map((c) => c.path)).toEqual(["/p/intro.tex", "/p/results.tex"]);
    expect(root.graphics.map((g) => g.path)).toEqual(["/p/fig/plot.png"]);
  });

  it("keeps an \\input that follows an escaped \\% on the same line", async () => {
    mockFiles({
      "/p/main.tex": "Coverage: 90\\% \\input{intro}\n",
      "/p/intro.tex": "hi",
    });
    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.children.map((c) => c.path)).toEqual(["/p/intro.tex"]);
  });

  it("does not revisit a file inputted twice (cycle/duplicate guard)", async () => {
    mockFiles({
      "/p/main.tex": "\\input{a}\n\\input{a}\n",
      "/p/a.tex": "\\input{main}\n", // would cycle back to main
    });

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    // The second \input{a} is skipped (already visited); a's \input{main} is too.
    expect(root.children.map((c) => c.path)).toEqual(["/p/a.tex"]);
    expect(root.children[0].children).toEqual([]);
  });

  it("is bounded to ~60 files even for a wide fan-out", async () => {
    const inputs = Array.from({ length: 200 }, (_, i) => `\\input{f${i}}`).join("\n");
    const files: Record<string, string> = { "/p/main.tex": inputs };
    for (let i = 0; i < 200; i++) files[`/p/f${i}.tex`] = "leaf";
    mockFiles(files);

    const { root } = await gatherTexStructure("/p/main.tex", "proj");
    expect(root.children.length).toBeLessThanOrEqual(60);
  });
});
