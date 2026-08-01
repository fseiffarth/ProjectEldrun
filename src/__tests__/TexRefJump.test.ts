/**
 * Tests for following a LaTeX cross-reference to its definition (#tex-ref-jump):
 * Ctrl/Cmd+click a `\ref{…}` and land on the `\label{…}`, a `\cite{…}` and land on
 * the `.bib` record.
 *
 * The properties pinned here are the ones that decide whether the click is worth
 * making at all: only a reference/citation command is a link (a `\label` is a
 * definition, not a reference to one, and `\textbf{…}` is neither); the key under
 * the caret wins in a multi-key `\cite{a,b}`; a commented-out reference is not
 * followed and a commented-out label is not a destination; the file being edited
 * is searched from the caller's **draft**, so a label typed a minute ago is
 * findable; and a key nothing defines resolves to null rather than to a wrong
 * place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import {
  findTexKeyRefAt,
  texKeyRefRanges,
  resolveTexKeyRef,
} from "../lib/viewers/tex";

const MAIN = "/home/u/proj/main.tex";

/** Serve `resolve_tex_root` and `read_file_text` out of a path→text map; any file
 *  not in it fails to read, exactly as a missing one would. */
function mockFiles(files: Record<string, string>, root = MAIN) {
  mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "resolve_tex_root") return root;
    if (cmd === "read_file_text") {
      const path = args.path as string;
      if (path in files) return files[path];
      throw new Error("ENOENT");
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe("findTexKeyRefAt", () => {
  it("recognises the reference and citation families, wherever in the command the caret sits", () => {
    const src = "see \\eqref{eq:main} and \\citep[p.5]{knuth1984} there";
    // On the command word, in the key, and on the closing brace all count.
    expect(findTexKeyRefAt(src, src.indexOf("\\eqref") + 2)).toEqual({
      kind: "ref",
      key: "eq:main",
    });
    expect(findTexKeyRefAt(src, src.indexOf("eq:main") + 3)).toEqual({
      kind: "ref",
      key: "eq:main",
    });
    expect(findTexKeyRefAt(src, src.indexOf("knuth1984"))).toEqual({
      kind: "cite",
      key: "knuth1984",
    });
    // `\Cref` is `\cref`; any command with "cite" in it is a citation.
    expect(findTexKeyRefAt("\\Cref{sec:x}", 3)?.kind).toBe("ref");
    expect(findTexKeyRefAt("\\parencite{a}", 3)?.kind).toBe("cite");
  });

  it("picks the key under the caret out of a multi-key citation", () => {
    const src = "\\cite{alpha,beta,gamma}";
    expect(findTexKeyRefAt(src, src.indexOf("beta") + 1)?.key).toBe("beta");
    expect(findTexKeyRefAt(src, src.indexOf("gamma") + 1)?.key).toBe("gamma");
  });

  it("is nothing for everything that is not a reference to a key", () => {
    // A label DEFINES a key; following it would be a jump to where the caret is.
    expect(findTexKeyRefAt("\\label{eq:1}", 4)).toBeNull();
    expect(findTexKeyRefAt("\\textbf{bold}", 4)).toBeNull();
    expect(findTexKeyRefAt("\\input{intro}", 4)).toBeNull();
    // A commented-out reference is not a link.
    expect(findTexKeyRefAt("% see \\ref{eq:1}", 10)).toBeNull();
    // Nowhere near a command.
    expect(findTexKeyRefAt("plain text \\ref{eq:1}", 2)).toBeNull();
  });
});

describe("texKeyRefRanges", () => {
  it("covers each key, and only the key", () => {
    const src = "\\ref{a} \\cite{b, c} \\label{d} \\input{e}";
    const ranges = texKeyRefRanges(src);
    expect(ranges.map((r) => src.slice(r.start, r.end))).toEqual(["a", "b", "c"]);
  });

  it("leaves a commented-out reference undecorated", () => {
    const src = "\\ref{live}\n% \\ref{dead}\n";
    expect(texKeyRefRanges(src).map((r) => src.slice(r.start, r.end))).toEqual(["live"]);
  });
});

describe("resolveTexKeyRef", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds a label in the file being edited, from the unsaved draft", async () => {
    // Disk holds an older copy without the label; the draft has it.
    mockFiles({ [MAIN]: "\\documentclass{article}\n" });
    const draft = "\\documentclass{article}\n\\section{R}\n\\label{sec:r}\n";
    const loc = await resolveTexKeyRef(
      MAIN,
      { kind: "ref", key: "sec:r" },
      { currentText: draft },
    );
    expect(loc).toEqual({
      path: MAIN,
      viewer: "tex",
      label: "main.tex",
      kind: "ref",
      key: "sec:r",
      line: 3,
      column: 1,
    });
  });

  it("follows \\input into a child file for a label defined there", async () => {
    mockFiles({
      [MAIN]: "\\input{chapters/intro}\n",
      "/home/u/proj/chapters/intro.tex": "text\n\\begin{equation}\\label{eq:main}\\end{equation}\n",
    });
    const loc = await resolveTexKeyRef(MAIN, { kind: "ref", key: "eq:main" });
    expect(loc?.path).toBe("/home/u/proj/chapters/intro.tex");
    expect(loc?.label).toBe("intro.tex");
    expect(loc?.line).toBe(2);
  });

  it("never lands on a commented-out label", async () => {
    mockFiles({ [MAIN]: "% \\label{eq:x}\nreal text\n\\label{eq:x}\n" });
    const loc = await resolveTexKeyRef(MAIN, { kind: "ref", key: "eq:x" });
    expect(loc?.line).toBe(3);
  });

  it("resolves a citation to its record in the document's bibliography", async () => {
    mockFiles({
      [MAIN]: "\\addbibresource{refs.bib}\n",
      "/home/u/proj/refs.bib":
        "@article{other, title = {A}}\n\n@book{knuth1984,\n  title = {The TeXbook},\n}\n",
    });
    const loc = await resolveTexKeyRef(MAIN, { kind: "cite", key: "knuth1984" });
    expect(loc?.path).toBe("/home/u/proj/refs.bib");
    expect(loc?.line).toBe(3);
    expect(loc?.kind).toBe("cite");
  });

  it("is null for a key nothing defines, and never crosses the two families", async () => {
    mockFiles({
      [MAIN]: "\\addbibresource{refs.bib}\n\\label{eq:1}\n",
      "/home/u/proj/refs.bib": "@book{knuth1984, title = {The TeXbook}}\n",
    });
    // A `\ref` written before its label — an ordinary state of a draft.
    expect(await resolveTexKeyRef(MAIN, { kind: "ref", key: "eq:missing" })).toBeNull();
    // A label is not a citation key, and a bib key is not a label.
    expect(await resolveTexKeyRef(MAIN, { kind: "cite", key: "eq:1" })).toBeNull();
    expect(await resolveTexKeyRef(MAIN, { kind: "ref", key: "knuth1984" })).toBeNull();
  });

  it("survives an unreadable file rather than failing the click", async () => {
    mockFiles({ [MAIN]: "\\input{gone}\n\\label{here}\n" });
    const loc = await resolveTexKeyRef(MAIN, { kind: "ref", key: "here" });
    expect(loc?.line).toBe(2);
  });
});
