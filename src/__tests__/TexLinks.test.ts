/**
 * Tests for the LaTeX viewer's cross-file reference following (Ctrl/Cmd+Click an
 * `\input{…}` etc. to open the referenced file in a new tab):
 *  - findTexRefAt locates the reference the caret sits on and picks the right
 *    comma-separated token.
 *  - resolveTexRef applies the per-command default extension, resolves relative
 *    paths (including `..`) against the .tex file, and maps to a built-in viewer.
 *  - resolveTexRefAsync probes the directory for a bare \includegraphics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  findTexRefAt,
  resolveTexRef,
  resolveTexRefAsync,
  texRefRanges,
} from "../lib/viewers/tex";

const MAIN = "/home/u/proj/paper.tex";

describe("findTexRefAt", () => {
  it("finds an \\input under the caret and returns its token", () => {
    const src = "intro\n\\input{chapters/intro}\nmore";
    const caret = src.indexOf("chapters");
    expect(findTexRefAt(src, caret)).toEqual({ command: "input", token: "chapters/intro" });
  });

  it("treats a click anywhere on the command (e.g. the backslash) as on the ref", () => {
    const src = "\\include{body}";
    expect(findTexRefAt(src, 0)).toEqual({ command: "include", token: "body" });
  });

  it("returns null when the caret is outside any reference", () => {
    const src = "plain \\input{a.tex} text";
    expect(findTexRefAt(src, src.length - 1)).toBeNull();
  });

  it("skips an optional bracket group (\\includegraphics[width=...]{fig})", () => {
    const src = "\\includegraphics[width=0.5\\textwidth]{figs/plot}";
    const caret = src.indexOf("plot");
    expect(findTexRefAt(src, caret)).toEqual({ command: "includegraphics", token: "figs/plot" });
  });

  it("picks the comma-separated token under the caret (\\bibliography{a,b})", () => {
    const src = "\\bibliography{refs,extra}";
    const onExtra = src.indexOf("extra") + 1;
    expect(findTexRefAt(src, onExtra)).toEqual({ command: "bibliography", token: "extra" });
    const onRefs = src.indexOf("refs") + 1;
    expect(findTexRefAt(src, onRefs)).toEqual({ command: "bibliography", token: "refs" });
  });
});

describe("texRefRanges (#49 clickable-link decoration)", () => {
  it("returns the argument range of an \\input so it can be underlined", () => {
    const src = "before \\input{chapters/intro} after";
    const ranges = texRefRanges(src);
    expect(ranges).toHaveLength(1);
    const { start, end } = ranges[0];
    expect(src.slice(start, end)).toBe("chapters/intro");
  });

  it("emits one range per comma-separated token (\\bibliography{a,b})", () => {
    const src = "\\bibliography{refs, extra}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["refs", "extra"]);
  });

  it("skips the optional bracket group of \\includegraphics", () => {
    const src = "\\includegraphics[width=0.5\\textwidth]{figs/plot}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["figs/plot"]);
  });

  it("finds multiple references across the document", () => {
    const src = "\\input{a}\ntext\n\\include{b}";
    const ranges = texRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["a", "b"]);
  });

  it("returns nothing for source with no references", () => {
    expect(texRefRanges("just \\section{Title} text")).toEqual([]);
  });
});

describe("resolveTexRef", () => {
  it("appends .tex for \\input and resolves relative to the file", () => {
    expect(resolveTexRef(MAIN, { command: "input", token: "chapters/intro" })).toEqual({
      path: "/home/u/proj/chapters/intro.tex",
      viewer: "tex",
      label: "intro.tex",
    });
  });

  it("keeps an explicit extension and picks the matching viewer", () => {
    expect(resolveTexRef(MAIN, { command: "includegraphics", token: "figs/plot.png" })).toEqual({
      path: "/home/u/proj/figs/plot.png",
      viewer: "image",
      label: "plot.png",
    });
  });

  it("appends .bib for \\bibliography and opens it as text", () => {
    expect(resolveTexRef(MAIN, { command: "bibliography", token: "refs" })).toEqual({
      path: "/home/u/proj/refs.bib",
      viewer: "text",
      label: "refs.bib",
    });
  });

  it("collapses .. segments", () => {
    expect(resolveTexRef(MAIN, { command: "input", token: "../shared/defs" })?.path).toBe(
      "/home/u/shared/defs.tex",
    );
  });

  it("returns null for a bare \\includegraphics (extension unknown without probing)", () => {
    expect(resolveTexRef(MAIN, { command: "includegraphics", token: "figs/plot" })).toBeNull();
  });
});

describe("resolveTexRefAsync (\\includegraphics directory probe)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the target directory and picks the stem match by extension preference", async () => {
    mockInvoke.mockResolvedValueOnce([
      { name: "plot.tex", path: "/home/u/proj/figs/plot.tex", is_dir: false, size: 0, extension: ".tex", mime: null },
      { name: "plot.png", path: "/home/u/proj/figs/plot.png", is_dir: false, size: 0, extension: ".png", mime: null },
      { name: "plot.pdf", path: "/home/u/proj/figs/plot.pdf", is_dir: false, size: 0, extension: ".pdf", mime: null },
    ]);

    const res = await resolveTexRefAsync(MAIN, { command: "includegraphics", token: "figs/plot" });
    // .pdf outranks .png in the graphics preference order; the .tex is ignored.
    expect(res).toEqual({ path: "/home/u/proj/figs/plot.pdf", viewer: "pdf", label: "plot.pdf" });
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { projectDir: "/home/u/proj/figs", relPath: "" });
  });

  it("returns null when no graphics file shares the stem", async () => {
    mockInvoke.mockResolvedValueOnce([
      { name: "other.png", path: "/home/u/proj/other.png", is_dir: false, size: 0, extension: ".png", mime: null },
    ]);
    expect(await resolveTexRefAsync(MAIN, { command: "includegraphics", token: "plot" })).toBeNull();
  });

  it("does not probe for commands with a deterministic extension", async () => {
    const res = await resolveTexRefAsync(MAIN, { command: "input", token: "intro" });
    expect(res?.path).toBe("/home/u/proj/intro.tex");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
