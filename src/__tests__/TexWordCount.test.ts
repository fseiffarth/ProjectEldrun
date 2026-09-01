import { describe, it, expect } from "vitest";
import { texWordCount } from "../lib/viewers/tex";

describe("texWordCount", () => {
  it("counts only the body of a file that has one", () => {
    const src = [
      "\\documentclass{article}",
      "\\usepackage[utf8]{inputenc}",
      "\\title{A preamble title nobody counts}",
      "\\begin{document}",
      "one two three",
      "\\end{document}",
      "trailing junk after the document",
    ].join("\n");
    const c = texWordCount(src);
    expect(c.words).toBe(3);
    expect(c.headers).toBe(0); // the \title is in the preamble, outside the body
  });

  it("reads a child file whole — it IS body", () => {
    expect(texWordCount("a chapter with five plain words").words).toBe(6);
  });

  it("does not count a command name, but does count what it wraps", () => {
    expect(texWordCount("a \\textbf{bold} word").words).toBe(3);
  });

  it("keeps a word interrupted by markup as one word", () => {
    // `super\emph{script}` is one word to a reader, and `wc -w` agrees.
    expect(texWordCount("super\\emph{script}").words).toBe(1);
  });

  it("counts a heading apart from the body", () => {
    const c = texWordCount("\\section{Related Work}\nSome body text here.");
    expect(c).toMatchObject({ headers: 1, headerWords: 2, words: 4 });
  });

  it("skips a heading's optional short title", () => {
    const c = texWordCount("\\section[Short]{The Full Heading}\n");
    expect(c.headerWords).toBe(3);
  });

  it("counts a caption apart, and its float", () => {
    const c = texWordCount(
      "\\begin{figure}\n\\includegraphics{plot.pdf}\n\\caption{A caption of five words}\n\\end{figure}\n",
    );
    expect(c).toMatchObject({ floats: 1, captionWords: 5, words: 0 });
  });

  it("counts a formula as one object, never as words", () => {
    const c = texWordCount("Let $x + y = z$ hold, and \\(a\\) too.");
    expect(c).toMatchObject({ inlineMath: 2, displayMath: 0 });
    // "Let", "hold", "and", "too" — the formulae contribute nothing.
    expect(c.words).toBe(4);
  });

  it("counts display math from both spellings and from the amsmath environments", () => {
    const c = texWordCount("\\[ x=1 \\]\n$$y=2$$\n\\begin{align}\nz=3\n\\end{align}\n");
    expect(c).toMatchObject({ displayMath: 3, words: 0 });
  });

  it("never counts a verbatim or a drawing as prose", () => {
    const c = texWordCount(
      "\\begin{lstlisting}\nfor x in range(10): print(x)\n\\end{lstlisting}\n" +
        "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1) node {label here};\n\\end{tikzpicture}\nreal text",
    );
    expect(c.words).toBe(2);
  });

  it("skips machinery arguments — a path is not prose", () => {
    const c = texWordCount(
      "\\includegraphics[width=0.8\\textwidth]{figures/deep/nested/plot.pdf}\n" +
        "\\label{fig:the-plot} \\cite{knuth1984} \\input{chapters/intro}\nSee it.",
    );
    expect(c.words).toBe(2); // "See", "it"
  });

  it("does not count a comment", () => {
    expect(texWordCount("real words here\n% four commented out words\n").words).toBe(3);
  });

  it("counts characters of the counted words only", () => {
    const c = texWordCount("ab cde");
    expect(c).toMatchObject({ words: 2, characters: 5 });
  });

  it("counts a hyphenated or apostrophed word once", () => {
    expect(texWordCount("state-of-the-art doesn't").words).toBe(2);
  });

  it("counts accented and non-Latin words", () => {
    expect(texWordCount("Überprüfung naïve 漢字").words).toBe(3);
  });

  it("does not count punctuation as a word", () => {
    expect(texWordCount("--- ... !? \\\\").words).toBe(0);
  });

  it("survives an unterminated group without hanging or throwing", () => {
    expect(() => texWordCount("\\section{never closed")).not.toThrow();
    expect(() => texWordCount("$unclosed math")).not.toThrow();
    expect(() => texWordCount("\\begin{align}\nno end")).not.toThrow();
  });

  it("is zero for an empty document", () => {
    expect(texWordCount("")).toMatchObject({ words: 0, characters: 0, headers: 0 });
  });
});
