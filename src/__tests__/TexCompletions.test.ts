import { describe, it, expect } from "vitest";
import {
  blankTexComments,
  findTexComplAt,
  insertTexCommand,
  insertTexEnvironment,
  parseTexDefinedCommands,
  parseTexDocumentEnvironments,
  texCompletionsFor,
  texEnvComplCommand,
  texKeyRefRanges,
  TEX_STANDARD_COMMANDS,
  TEX_STANDARD_ENVIRONMENTS,
  type TexComplContext,
} from "../lib/viewers/tex";

/** The context the editor would build with the caret at `|` in `src`. */
function ctxAt(src: string): { text: string; ctx: TexComplContext | null } {
  const caret = src.indexOf("|");
  const text = src.replace("|", "");
  return { text, ctx: findTexComplAt(text, caret) };
}

describe("findTexComplAt — command context (#245)", () => {
  it("offers a command while one is being typed", () => {
    const { ctx } = ctxAt("Hello \\sec|");
    expect(ctx).toEqual({ kind: "cmd", start: 6, end: 10, query: "sec" });
  });

  it("replaces from the backslash, so accepting rewrites the whole name", () => {
    const { text, ctx } = ctxAt("\\includegraph|");
    expect(text.slice(ctx!.start, ctx!.end)).toBe("\\includegraph");
  });

  it("stays shut on a bare backslash — the first keystroke of \\\\, \\[ and \\%", () => {
    expect(ctxAt("a \\|").ctx).toBeNull();
  });

  it("stays shut after an escaped backslash (a line break, not a command)", () => {
    // `\\se` is a `\\` break followed by the letters `se`, not a command.
    expect(ctxAt("row \\\\se|").ctx).toBeNull();
  });

  it("stays shut inside a comment", () => {
    expect(ctxAt("% see \\sec|").ctx).toBeNull();
    // …but an escaped percent is not a comment.
    expect(ctxAt("100\\% of \\sec|").ctx?.kind).toBe("cmd");
  });

  it("does not fire on letters that are not preceded by a backslash", () => {
    expect(ctxAt("section|").ctx).toBeNull();
  });
});

describe("findTexComplAt — environment context (#245)", () => {
  it("offers an environment inside \\begin{…}", () => {
    const { ctx } = ctxAt("\\begin{item|");
    expect(ctx).toMatchObject({ kind: "env", query: "item" });
  });

  it("offers one inside \\end{…} too", () => {
    expect(ctxAt("\\end{align|").ctx).toMatchObject({ kind: "env", query: "align" });
  });

  it("offers one on an empty brace, so the list is browsable", () => {
    expect(ctxAt("\\begin{|").ctx).toMatchObject({ kind: "env", query: "" });
  });

  it("leaves \\ref/\\cite classified as before", () => {
    expect(ctxAt("\\ref{eq:|").ctx?.kind).toBe("ref");
    expect(ctxAt("\\citep[see][p.5]{knu|").ctx?.kind).toBe("cite");
  });

  it("does not treat \\newenvironment's own name argument as a candidate", () => {
    // Its first argument is the name being DEFINED — offering `itemize` there
    // would suggest redefining it rather than naming something new.
    expect(ctxAt("\\newenvironment{myb|").ctx).toBeNull();
  });

  it("reads which of begin/end a context belongs to off the source", () => {
    const b = ctxAt("\\begin{fig|");
    expect(texEnvComplCommand(b.text, b.ctx!)).toBe("begin");
    const e = ctxAt("\\end{fig|");
    expect(texEnvComplCommand(e.text, e.ctx!)).toBe("end");
  });
});

describe("parseTexDefinedCommands", () => {
  it("finds the whole \\newcommand family with their arity", () => {
    const src = [
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\renewcommand{\\vec}[1]{\\mathbf{#1}}",
      "\\providecommand\\eps{\\varepsilon}",
      "\\DeclareMathOperator{\\argmin}{arg\\,min}",
      "\\def\\myshort{x}",
    ].join("\n");
    expect(parseTexDefinedCommands(src)).toEqual([
      { name: "R", args: 0, local: true },
      { name: "vec", args: 1, local: true },
      { name: "eps", args: 0, local: true },
      { name: "argmin", args: 0, local: true },
      { name: "myshort", args: 0, local: true },
    ]);
  });

  it("ignores a commented-out definition", () => {
    expect(parseTexDefinedCommands("% \\newcommand{\\dead}{x}")).toEqual([]);
  });
});

describe("parseTexDocumentEnvironments", () => {
  it("collects defined and already-used environments, deduplicated", () => {
    const src = [
      "\\newtheorem{claim}{Claim}",
      "\\newenvironment{sidebar}{}{}",
      "\\begin{wrapfigure}{r}{4cm}",
      "\\end{wrapfigure}",
      "\\begin{wrapfigure}{l}{4cm}",
      "\\end{wrapfigure}",
    ].join("\n");
    expect(parseTexDocumentEnvironments(src).map((e) => e.name)).toEqual([
      "claim",
      "sidebar",
      "wrapfigure",
    ]);
  });

  it("ignores a commented-out \\begin", () => {
    expect(parseTexDocumentEnvironments("% \\begin{ghost}")).toEqual([]);
  });
});

describe("insertTexCommand", () => {
  const cmdCtx = (src: string) => ctxAt(src) as { text: string; ctx: TexComplContext };

  it("writes the command and seeds its brace argument", () => {
    const { text, ctx } = cmdCtx("Intro \\sec|");
    const out = insertTexCommand(text, ctx, { name: "section", args: 1 });
    expect(out.text).toBe("Intro \\section{}");
    expect(out.text[out.caret]).toBe("}"); // caret sits INSIDE the braces
  });

  it("seeds every mandatory argument and lands in the first", () => {
    const { text, ctx } = cmdCtx("\\fra|");
    const out = insertTexCommand(text, ctx, { name: "frac", args: 2 });
    expect(out.text).toBe("\\frac{}{}");
    expect(out.caret).toBe("\\frac{".length);
  });

  it("adds no braces to an argument-less command", () => {
    const { text, ctx } = cmdCtx("\\quа|".replace("а", "a"));
    const out = insertTexCommand(text, ctx, { name: "quad", args: 0 });
    expect(out.text).toBe("\\quad");
    expect(out.caret).toBe(out.text.length);
  });

  it("does not add a second brace when the text already continues with one", () => {
    // Correcting the name of a command that is already written out.
    const caret = "\\sectio".length;
    const text = "\\sectio{Intro}";
    const ctx = findTexComplAt(text, caret)!;
    const out = insertTexCommand(text, ctx, { name: "section", args: 1 });
    expect(out.text).toBe("\\section{Intro}");
  });
});

describe("insertTexEnvironment", () => {
  it("closes a \\begin{…} block, with the caret in the body", () => {
    const { text, ctx } = ctxAt("\\begin{ali|}\n");
    const out = insertTexEnvironment(text, ctx!, { name: "align" });
    expect(out.text).toBe("\\begin{align}\n  \n\\end{align}\n");
    expect(out.caret).toBe("\\begin{align}\n  ".length);
  });

  it("keeps the \\begin's indent on the body and the \\end", () => {
    const { text, ctx } = ctxAt("    \\begin{ite|}\n");
    const out = insertTexEnvironment(text, ctx!, { name: "itemize", item: "\\item " });
    expect(out.text).toBe("    \\begin{itemize}\n      \\item \n    \\end{itemize}\n");
    expect(out.caret).toBe(out.text.indexOf("\\item ") + "\\item ".length);
  });

  it("seeds an argument the environment cannot compile without, caret inside it", () => {
    const { text, ctx } = ctxAt("\\begin{tab|}\n");
    const out = insertTexEnvironment(text, ctx!, { name: "tabular", seed: "{}" });
    expect(out.text).toBe("\\begin{tabular}{}\n  \n\\end{tabular}\n");
    expect(out.text[out.caret]).toBe("}");
  });

  it("does not insert a second \\end when the block is already closed", () => {
    // Re-typing the name of a block that exists: the `\end` below is the match.
    const src = "\\begin{ali|}\nx = y\n\\end{align}\n";
    const { text, ctx } = ctxAt(src);
    const out = insertTexEnvironment(text, ctx!, { name: "align" });
    expect(out.text).toBe("\\begin{align}\nx = y\n\\end{align}\n");
    expect(out.caret).toBe("\\begin{align}".length);
  });

  it("still opens a block when the only \\end ahead already belongs to a nested pair", () => {
    // The `\end{align}` below closes the `\begin{align}` between it and the
    // caret, so this block genuinely has none and one must be written.
    const { text, ctx } = ctxAt("\\begin{ali|}\n\\begin{align}\n\\end{align}\n");
    const out = insertTexEnvironment(text, ctx!, { name: "align" });
    expect(out.text.match(/\\end\{align\}/g)).toHaveLength(2);
  });

  it("writes the name only in an \\end{…}", () => {
    const { text, ctx } = ctxAt("\\begin{align}\nx\n\\end{ali|}\n");
    const out = insertTexEnvironment(text, ctx!, { name: "align" });
    expect(out.text).toBe("\\begin{align}\nx\n\\end{align}\n");
    expect(out.caret).toBe(out.text.indexOf("\\end{align}") + "\\end{align}".length);
  });

  it("writes the name only when the line continues after the braces", () => {
    // Restructuring a line the user is in the middle of is what an autocomplete
    // must not do.
    const { text, ctx } = ctxAt("\\begin{cen|} some text\n");
    const out = insertTexEnvironment(text, ctx!, { name: "center" });
    expect(out.text).toBe("\\begin{center} some text\n");
  });

  it("writes the name only when something else is still inside the braces", () => {
    const text = "\\begin{fig figure}\n";
    const ctx = findTexComplAt(text, "\\begin{fig".length)!;
    const out = insertTexEnvironment(text, ctx, { name: "figure" });
    expect(out.text).toBe("\\begin{figure figure}\n");
  });
});

describe("the standard tables", () => {
  it("parse into well-formed entries", () => {
    for (const c of TEX_STANDARD_COMMANDS) {
      expect(c.name).toMatch(/^[a-zA-Z]+$/);
      expect(Number.isInteger(c.args)).toBe(true);
      expect(c.args).toBeGreaterThanOrEqual(0);
    }
    expect(TEX_STANDARD_COMMANDS.find((c) => c.name === "frac")?.args).toBe(2);
    expect(TEX_STANDARD_COMMANDS.find((c) => c.name === "quad")?.args).toBe(0);
  });

  it("name each command and environment only once", () => {
    const cmds = TEX_STANDARD_COMMANDS.map((c) => c.name);
    expect(new Set(cmds).size).toBe(cmds.length);
    const envs = TEX_STANDARD_ENVIRONMENTS.map((e) => e.name);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("give every list environment a first item and every argument-taking one a seed", () => {
    const byName = new Map(TEX_STANDARD_ENVIRONMENTS.map((e) => [e.name, e]));
    expect(byName.get("itemize")?.item).toBe("\\item ");
    expect(byName.get("enumerate")?.item).toBe("\\item ");
    expect(byName.get("tabular")?.seed).toBe("{}");
    expect(byName.get("equation")?.seed).toBeUndefined();
  });
});

// --- Keystroke cost (the autocomplete slowdown) -------------------------------
//
// The editor used to re-parse the whole document on every keystroke of every TeX
// file, dropdown or not, and the parsers ran a character-at-a-time comment
// blanker up to four times per character typed. These pin the replacements:
// the fast blanker is byte-for-byte the old one, the narrowed key-ref regex
// finds the same links, and the per-family merge the editor now calls lazily
// puts the draft's own definitions first.

/** The character-at-a-time blanker the `indexOf` version replaced — kept as the
 *  reference the fast one is checked against. */
function blankTexCommentsReference(source: string): string {
  const escaped = (pos: number) => {
    let n = 0;
    for (let i = pos - 1; i >= 0 && source[i] === "\\"; i--) n++;
    return n % 2 === 1;
  };
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "%" && !escaped(i)) {
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

describe("blankTexComments — the fast blanker matches the reference", () => {
  const cases = [
    "",
    "%",
    "% only a comment",
    "no comments at all\nacross lines\n",
    "text % comment\nmore % another\n",
    "escaped \\% stays % but this goes\n",
    "double \\\\% is a comment\n",
    "triple \\\\\\% is escaped\n",
    "% at start\n%\n%%\nlast line % trailing without newline",
    "\\cite{a} % c\n\\ref{b}\n",
  ];
  for (const src of cases) {
    it(`blanks ${JSON.stringify(src).slice(0, 40)} identically`, () => {
      const got = blankTexComments(src);
      expect(got).toBe(blankTexCommentsReference(src));
      expect(got.length).toBe(src.length);
    });
  }

  it("returns the very same string when there is nothing to blank", () => {
    const src = "a \\% b\nc";
    expect(blankTexComments(src)).toBe(src);
  });
});

describe("texKeyRefRanges — narrowed scan finds the same links", () => {
  it("underlines ref/cite keys and nothing else", () => {
    const src = "\\textbf{x} \\ref{a} \\Cref{b} \\citep[p.~5]{c,d} \\refx{e} \\parencite{f}";
    const keys = texKeyRefRanges(src).map((r) => src.slice(r.start, r.end));
    expect(keys).toEqual(["a", "b", "c", "d", "f"]);
  });

  it("skips a commented-out reference", () => {
    const src = "% \\ref{a}\n\\ref{b}";
    const keys = texKeyRefRanges(src).map((r) => src.slice(r.start, r.end));
    expect(keys).toEqual(["b"]);
  });
});

describe("texCompletionsFor — the per-family live merge", () => {
  const gathered = {
    labels: [{ key: "sec:intro", section: "Intro" }, { key: "fig:one" }],
    cites: [{ key: "knuth84", type: "book" }],
    commands: TEX_STANDARD_COMMANDS,
    envs: TEX_STANDARD_ENVIRONMENTS,
  };
  const draft = [
    "\\newcommand{\\R}{\\mathbb{R}}",
    "\\newcommand{\\section}{x}", // shadows a standard entry — offered once, as local
    "\\label{fig:one}", // already gathered — offered once
    "\\label{eq:new}",
    "\\begin{wrapfigure}",
  ].join("\n");

  it("puts the draft's own labels first and deduplicates by key", () => {
    expect(texCompletionsFor(gathered, draft, "ref").map((l) => l.key)).toEqual([
      "fig:one", "eq:new", "sec:intro",
    ]);
  });

  it("puts the draft's own commands first, once, marked local", () => {
    const cmds = texCompletionsFor(gathered, draft, "cmd");
    expect(cmds.slice(0, 2)).toEqual([
      { name: "R", args: 0, local: true },
      { name: "section", args: 0, local: true },
    ]);
    expect(cmds.filter((c) => c.name === "section")).toHaveLength(1);
    expect(cmds.length).toBe(TEX_STANDARD_COMMANDS.length + 1);
  });

  it("adds an environment the draft already uses", () => {
    const envs = texCompletionsFor(gathered, draft, "env");
    expect(envs[0]).toEqual({ name: "wrapfigure", local: true });
    expect(envs.length).toBe(TEX_STANDARD_ENVIRONMENTS.length + 1);
  });

  it("has nothing live for citations — the .bib is never the file being edited", () => {
    expect(texCompletionsFor(gathered, draft, "cite")).toBe(gathered.cites);
  });
});
