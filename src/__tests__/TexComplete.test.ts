/**
 * Tests for the LaTeX viewer's \ref/\cite key autocomplete:
 *  - findTexComplAt detects a caret inside a ref- or cite-family command's
 *    (possibly unclosed) braces and reports the token to complete.
 *  - parseTexLabels / parseBibEntries extract the candidate keys.
 *  - gatherTexCompletions walks \input + \bibliography to union them from disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  findTexComplAt,
  parseTexLabels,
  parseBibEntries,
  gatherTexCompletions,
} from "../lib/viewers/tex";

describe("findTexComplAt", () => {
  it("detects a partial \\cite key (unclosed brace)", () => {
    const src = "see \\cite{ein";
    const ctx = findTexComplAt(src, src.length);
    expect(ctx).toEqual({ kind: "cite", start: src.indexOf("ein"), end: src.length, query: "ein" });
  });

  it("detects the empty \\cref{ argument (offers all labels)", () => {
    const src = "as in \\cref{";
    const ctx = findTexComplAt(src, src.length);
    expect(ctx).toEqual({ kind: "ref", start: src.length, end: src.length, query: "" });
  });

  it("classifies the various ref-family commands", () => {
    for (const cmd of ["ref", "autoref", "eqref", "Cref", "vref", "pageref"]) {
      const src = `\\${cmd}{fig`;
      expect(findTexComplAt(src, src.length)?.kind).toBe("ref");
    }
  });

  it("classifies natbib/biblatex cite variants", () => {
    for (const cmd of ["cite", "citep", "citet", "parencite", "textcite", "footcite"]) {
      const src = `\\${cmd}{k`;
      expect(findTexComplAt(src, src.length)?.kind).toBe("cite");
    }
  });

  it("completes only the token under the caret in a multi-key \\cite{a,b", () => {
    const src = "\\cite{alpha, bet";
    const ctx = findTexComplAt(src, src.length);
    expect(ctx).toEqual({ kind: "cite", start: src.indexOf("bet"), end: src.length, query: "bet" });
  });

  it("skips optional arguments (\\citep[see][p.5]{key)", () => {
    const src = "\\citep[see][p.5]{ke";
    const ctx = findTexComplAt(src, src.length);
    expect(ctx?.kind).toBe("cite");
    expect(ctx?.query).toBe("ke");
  });

  it("returns null outside any ref/cite command", () => {
    expect(findTexComplAt("plain \\textbf{bold", 14)).toBeNull();
    expect(findTexComplAt("no braces here", 5)).toBeNull();
  });

  it("returns null once the argument brace has closed before the caret", () => {
    const src = "\\cite{done} now";
    expect(findTexComplAt(src, src.length)).toBeNull();
  });
});

describe("parseTexLabels", () => {
  it("extracts every \\label key", () => {
    const src = "\\section{A}\\label{sec:a}\ntext \\label{eq:1} more";
    expect(parseTexLabels(src)).toEqual(["sec:a", "eq:1"]);
  });

  it("returns nothing when there are no labels", () => {
    expect(parseTexLabels("no labels at all")).toEqual([]);
  });
});

describe("parseBibEntries", () => {
  it("reads keys and display fields, skipping @string/@comment", () => {
    const bib = `
      @string{jml = {J. ML}}
      @article{smith2020,
        author = {Smith, Jane and Doe, John},
        title = {On {LaTeX} Autocomplete},
        year = 2020,
      }
      @comment{ignored}
      @book{knuth1984, author = "Knuth, Donald", title = "The TeXbook", year = {1984}}
    `;
    const entries = parseBibEntries(bib);
    expect(entries.map((e) => e.key)).toEqual(["smith2020", "knuth1984"]);
    expect(entries[0]).toMatchObject({
      key: "smith2020",
      type: "article",
      author: "Smith, Jane and Doe, John",
      title: "On LaTeX Autocomplete",
      year: "2020",
    });
    expect(entries[1]).toMatchObject({ title: "The TeXbook", year: "1984" });
  });
});

describe("gatherTexCompletions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unions labels across \\input files and keys from \\bibliography", async () => {
    // resolve_tex_root → the file itself is the root here.
    const main = "/p/main.tex";
    const files: Record<string, string> = {
      "/p/main.tex":
        "\\label{sec:intro}\n\\input{chap}\n\\bibliography{refs}\n\\cite{a}",
      "/p/chap.tex": "\\label{eq:euler}\nmore text",
      "/p/refs.bib": "@article{a, title={A}}\n@book{b, title={B}}",
    };
    mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "resolve_tex_root") return Promise.resolve(main);
      if (cmd === "read_file_text") {
        const text = files[args.path!];
        return text != null ? Promise.resolve(text) : Promise.reject(new Error("missing"));
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    const { labels, cites } = await gatherTexCompletions(main);
    expect(labels.sort()).toEqual(["eq:euler", "sec:intro"]);
    expect(cites.map((c) => c.key).sort()).toEqual(["a", "b"]);
  });

  it("is best-effort when a referenced file is unreadable", async () => {
    const main = "/p/main.tex";
    mockInvoke.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "resolve_tex_root") return Promise.resolve(main);
      if (cmd === "read_file_text" && args.path === main)
        return Promise.resolve("\\label{x}\n\\bibliography{gone}");
      return Promise.reject(new Error("missing"));
    });
    const { labels, cites } = await gatherTexCompletions(main);
    expect(labels).toEqual(["x"]);
    expect(cites).toEqual([]);
  });
});
