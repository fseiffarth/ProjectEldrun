import { describe, it, expect } from "vitest";
import { parseTexWarnings, parseTexErrors } from "../lib/viewers/tex";

// A realistic (abridged) pdflatex log for a two-file document. Everything here
// is shaped the way TeX actually prints it — the `(file … )` nesting, the
// continuation line carrying `on input line N`, the box report with its own
// parenthesis — because those are exactly the shapes the parser exists for.
const LOG = `
This is pdfTeX, Version 3.141592653
(./main.tex
LaTeX2e <2023-11-01>
(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
)
(./main.aux (./chapters/intro.aux))
(./chapters/intro.tex
LaTeX Warning: Reference \`fig:missing' on page 1 undefined on input line 12.

Overfull \\hbox (15.28迷pt too wide) in paragraph at lines 20--22
[]\\OT1/cmr/m/n/10 A very long line that runs into the margin
)
LaTeX Warning: Citation \`knuth1984' on page 2 undefined on input
line 44.

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing \`math shift' on input line 51.

LaTeX Font Warning: Font shape \`OT1/cmr/bx/sc' undefined
(Font)              using \`OT1/cmr/bx/n' instead on input line 60.

LaTeX Warning: There were undefined references.
)
`.replace(/迷/g, "");

describe("parseTexWarnings", () => {
  const warns = parseTexWarnings(LOG);

  it("finds every warning a build reports, in order", () => {
    expect(warns.map((w) => w.kind)).toEqual([
      "reference",
      "box",
      "citation",
      "other",
      "font",
      "reference",
    ]);
  });

  it("reads the line out of `on input line N`", () => {
    expect(warns[0]).toMatchObject({ line: 12, kind: "reference" });
    expect(warns[0].message).toContain("fig:missing");
  });

  it("names the file the `(… )` nesting had open", () => {
    expect(warns[0].file).toBe("./chapters/intro.tex");
    // The citation warning is printed after intro.tex closed, back in main.tex.
    expect(warns[2].file).toBe("./main.tex");
  });

  it("follows a warning wrapped onto the next line", () => {
    // `on input line 44.` is on a continuation line of the citation warning.
    expect(warns[2]).toMatchObject({ kind: "citation", line: 44 });
  });

  it("reads a box report's own `at lines N--M`", () => {
    expect(warns[1]).toMatchObject({ kind: "box", line: 20, file: "./chapters/intro.tex" });
    expect(warns[1].message).toContain("Overfull box");
    expect(warns[1].message).toContain("15.28pt too wide");
  });

  it("names the package a package warning came from", () => {
    expect(warns[3].message.startsWith("hyperref: ")).toBe(true);
    expect(warns[3].line).toBe(51);
  });

  it("keeps a summary warning that carries no line", () => {
    expect(warns[5]).toMatchObject({ kind: "reference", line: undefined });
    expect(warns[5].message).toBe("There were undefined references.");
  });

  it("is empty for a clean log, and never throws on junk", () => {
    expect(parseTexWarnings("Output written on main.pdf (3 pages).")).toEqual([]);
    expect(parseTexWarnings("")).toEqual([]);
    expect(() => parseTexWarnings("((((\n))))\nWarning:")).not.toThrow();
  });

  it("collapses a warning TeX printed twice", () => {
    const twice = `LaTeX Warning: Reference \`a' undefined on input line 3.\n\nLaTeX Warning: Reference \`a' undefined on input line 3.\n`;
    expect(parseTexWarnings(twice)).toHaveLength(1);
  });

  it("does not report an error line as a warning", () => {
    const log = "./main.tex:9: Undefined control sequence.\n";
    expect(parseTexWarnings(log)).toEqual([]);
    expect(parseTexErrors(log)).toHaveLength(1);
  });

  it("attributes nothing rather than guessing when the nesting named no file", () => {
    const log = "LaTeX Warning: Reference `x' undefined on input line 5.\n";
    expect(parseTexWarnings(log)[0].file).toBeUndefined();
  });

  it("is not confused by a bracketed aside that is not a file", () => {
    // `(15.28pt too wide)` and the like must not pop a real file off the stack.
    const log = [
      "(./main.tex",
      "Overfull \\hbox (3.0pt too wide) in paragraph at lines 1--2",
      "LaTeX Warning: Reference `y' undefined on input line 7.",
    ].join("\n");
    expect(parseTexWarnings(log)[1].file).toBe("./main.tex");
  });
});
