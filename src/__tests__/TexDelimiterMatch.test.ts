/**
 * Tests for the LaTeX bracket-match extras: math-delimiter matching
 * (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and `\begin{env}…\end{env}` structure
 * matching. These feed `FileViewerPane`'s bracket-match overlay for `.tex`
 * files, once its plain ()[]{} matcher comes up empty.
 */
import { describe, it, expect } from "vitest";
import {
  findTexMathDelimiterMatch,
  findTexEnvDelimiterMatch,
  findTexDelimiterMatch,
  findTexEnvNameMatch,
  findUnclosedTexBrackets,
  syncTexEnvRename,
  texEnvNameRangeAt,
} from "../lib/viewers/tex";

function at(i: number, len = 1) {
  return { start: i, end: i + len };
}

/** An opening delimiter the document-wide diagnostic left unclosed. */
function unclosedAt(i: number, len = 1) {
  return { start: i, end: i + len, problem: "unclosed" as const };
}

/** An unmatched `\begin{env}` — the whole token, tagged with its name. */
function unclosedEnv(text: string, env: string, from = 0) {
  const start = text.indexOf(`\\begin{${env}}`, from);
  return { start, end: start + `\\begin{${env}}`.length, problem: "unclosed" as const, env };
}

/** An `\end{env}` closing nothing that is open. */
function unmatchedEnd(text: string, env: string, from = 0) {
  const start = text.indexOf(`\\end{${env}}`, from);
  return { start, end: start + `\\end{${env}}`.length, problem: "unmatchedEnd" as const, env };
}

describe("findUnclosedTexBrackets", () => {
  it("returns only opening ordinary brackets still missing their end", () => {
    const text = "\\section{closed}\nouter{inner{ok}\nvalue[done]\ncall(";
    expect(findUnclosedTexBrackets(text)).toEqual([
      unclosedAt(text.indexOf("outer{") + "outer".length),
      unclosedAt(text.lastIndexOf("(")),
    ]);
  });

  it("ignores commented and escaped literal brackets", () => {
    const text = "\\{printed\\} % { commented\n\\command{closed}";
    expect(findUnclosedTexBrackets(text)).toEqual([]);
  });

  it("includes unmatched math and environment opening delimiters", () => {
    const text = "\\[display\n\\begin{itemize}\n$inline";
    expect(findUnclosedTexBrackets(text)).toEqual([
      unclosedAt(text.indexOf("\\["), 2),
      unclosedEnv(text, "itemize"),
      unclosedAt(text.indexOf("$")),
    ]);
  });

  it("ignores extra closing brackets, whose group is ambiguous", () => {
    expect(findUnclosedTexBrackets(")]}\\)\\]")).toEqual([]);
  });

  // Environments pair BY NAME, unlike the caret-local matcher's depth count —
  // which is exactly what a depth count gets wrong, since a begin and an end of
  // different names cancel each other out and the file reads as balanced.
  it("flags both halves when \\begin and \\end name different environments", () => {
    const text = "\\begin{itemize}\n\\item a\n\\end{enumerate}\n";
    expect(findUnclosedTexBrackets(text)).toEqual([
      unclosedEnv(text, "itemize"),
      unmatchedEnd(text, "enumerate"),
    ]);
  });

  it("flags an \\end with no \\begin of that environment at all", () => {
    const text = "text\n\\end{itemize}\n";
    expect(findUnclosedTexBrackets(text)).toEqual([unmatchedEnd(text, "itemize")]);
  });

  it("blames the inner \\begin when an outer environment closes over it", () => {
    // Depth counting paired `\\end{document}` with `\\begin{itemize}` and reported
    // `\\begin{document}` — the one token that is not the mistake.
    const text = "\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{document}\n";
    expect(findUnclosedTexBrackets(text)).toEqual([unclosedEnv(text, "itemize")]);
  });

  it("reports crossed environments from both ends", () => {
    const text = "\\begin{a}\\begin{b}\\end{a}\\end{b}";
    expect(findUnclosedTexBrackets(text)).toEqual([
      unclosedEnv(text, "b"),
      unmatchedEnd(text, "b"),
    ]);
  });

  it("pairs repeated and nested environments of the same name", () => {
    const text =
      "\\begin{itemize}\\begin{itemize}\\end{itemize}\\end{itemize}\n" +
      "\\begin{itemize}\\end{itemize}";
    expect(findUnclosedTexBrackets(text)).toEqual([]);
  });

  it("ignores a commented-out \\end", () => {
    const text = "\\begin{itemize}\n% \\end{itemize}\n\\end{itemize}";
    expect(findUnclosedTexBrackets(text)).toEqual([]);
  });

  it("tolerates spacing inside the environment braces", () => {
    expect(findUnclosedTexBrackets("\\begin{ itemize }x\\end{itemize}")).toEqual([]);
  });

  it("reads a line break's optional spacing as a bracket, never as \\[ display math", () => {
    // `\\[2mm]` is a row break plus an ordinary optional argument. Reading its
    // second backslash as the start of `\[` made every spaced table row an
    // unclosed display-math opener.
    const text = "\\begin{tabular}{ll}\na & b \\\\[2mm]\nc & d \\\\\n\\end{tabular}";
    expect(findUnclosedTexBrackets(text)).toEqual([]);
  });

  it("still diagnoses a real \\[ that follows an escaped backslash", () => {
    // `\\\[` is a line break followed by a genuine display-math opener — the
    // parity rule, so consuming the escaped character must not swallow it.
    const text = "row \\\\\\[x";
    expect(findUnclosedTexBrackets(text)).toEqual([unclosedAt(text.indexOf("\\[", 4), 2)]);
  });
});

describe("findTexMathDelimiterMatch", () => {
  it("matches inline math $…$ from either $ and from inside the math", () => {
    const text = "a $x+y$ b";
    const open = text.indexOf("$");
    const close = text.lastIndexOf("$");
    const expected = { open: at(open), close: at(close) };
    expect(findTexMathDelimiterMatch(text, open)).toEqual(expected); // before opening $
    expect(findTexMathDelimiterMatch(text, open + 1)).toEqual(expected); // after opening $
    expect(findTexMathDelimiterMatch(text, close)).toEqual(expected); // before closing $
    expect(findTexMathDelimiterMatch(text, close + 1)).toEqual(expected); // after closing $
  });

  it("matches display math $$…$$ as a single 2-character token, not two inline pairs", () => {
    const text = "$$E=mc^2$$";
    const open = 0;
    const close = text.lastIndexOf("$$");
    expect(findTexMathDelimiterMatch(text, open)).toEqual({ open: at(open, 2), close: at(close, 2) });
    // Touching the middle of the closing "$$" (between the two $ chars) still counts.
    expect(findTexMathDelimiterMatch(text, close + 1)).toEqual({ open: at(open, 2), close: at(close, 2) });
  });

  it("matches \\(…\\) and \\[…\\]", () => {
    const paren = "\\(x\\)";
    const pOpen = paren.indexOf("\\(");
    const pClose = paren.indexOf("\\)");
    expect(findTexMathDelimiterMatch(paren, pOpen)).toEqual({
      open: at(pOpen, 2),
      close: at(pClose, 2),
    });

    const bracket = "\\[x\\]";
    const bOpen = bracket.indexOf("\\[");
    const bClose = bracket.indexOf("\\]");
    expect(findTexMathDelimiterMatch(bracket, bOpen)).toEqual({
      open: at(bOpen, 2),
      close: at(bClose, 2),
    });
  });

  it("matches touching any position inside a multi-character token, not just its ends", () => {
    const text = "\\[x\\]";
    const bOpen = 0; // "\[" spans [0,2)
    expect(findTexMathDelimiterMatch(text, 1)).toEqual({ open: at(bOpen, 2), close: at(3, 2) });
  });

  it("does not treat an escaped \\$ as a math toggle", () => {
    // "\$5 $x$ \$10" — the two \$ are literal dollar signs; only the middle
    // pair is real math.
    const text = "\\$5 $x$ \\$10";
    const realOpen = text.indexOf("$", text.indexOf("5")); // first non-escaped $
    const realClose = text.indexOf("$", realOpen + 1);
    expect(findTexMathDelimiterMatch(text, realOpen)).toEqual({
      open: at(realOpen),
      close: at(realClose),
    });
    // Caret on the escaped \$ finds nothing (it's not a token at all).
    expect(findTexMathDelimiterMatch(text, text.indexOf("\\$"))).toBeNull();
  });

  it("returns null for an unmatched (odd) $", () => {
    expect(findTexMathDelimiterMatch("only $one dollar", 5)).toBeNull();
  });

  it("returns null when the caret touches no math delimiter", () => {
    expect(findTexMathDelimiterMatch("plain text, no math", 5)).toBeNull();
  });

  it("keeps \\( and \\[ nesting independent (mismatched kinds don't pair)", () => {
    // "\(x\]" — an opening paren-math with a bracket-math close: neither
    // resolves, since \( only pairs with \) and \[ only with \].
    const text = "\\(x\\]";
    expect(findTexMathDelimiterMatch(text, 0)).toBeNull();
  });
});

describe("findTexEnvDelimiterMatch", () => {
  it("matches \\begin{env} to its \\end{env}", () => {
    const text = "\\begin{itemize}\\item a\\end{itemize}";
    const begin = text.indexOf("\\begin");
    const end = text.indexOf("\\end");
    const beginEnd = text.indexOf("}", begin) + 1;
    const endEnd = text.indexOf("}", end) + 1;
    const expected = { open: { start: begin, end: beginEnd }, close: { start: end, end: endEnd } };
    expect(findTexEnvDelimiterMatch(text, begin)).toEqual(expected);
    expect(findTexEnvDelimiterMatch(text, endEnd)).toEqual(expected);
  });

  it("matches the correct pair across sibling environments (name-agnostic depth count)", () => {
    const text = "\\begin{a}1\\end{a}\\begin{b}2\\end{b}";
    const secondBegin = text.lastIndexOf("\\begin");
    const secondEnd = text.lastIndexOf("\\end");
    const secondBeginEnd = text.indexOf("}", secondBegin) + 1;
    const secondEndEnd = text.indexOf("}", secondEnd) + 1;
    expect(findTexEnvDelimiterMatch(text, secondBegin)).toEqual({
      open: { start: secondBegin, end: secondBeginEnd },
      close: { start: secondEnd, end: secondEndEnd },
    });
  });

  it("matches the inner pair of nested environments", () => {
    const text = "\\begin{a}\\begin{b}x\\end{b}\\end{a}";
    const innerBegin = text.indexOf("\\begin{b}");
    const innerEnd = text.indexOf("\\end{b}");
    const innerBeginEnd = innerBegin + "\\begin{b}".length;
    const innerEndEnd = innerEnd + "\\end{b}".length;
    expect(findTexEnvDelimiterMatch(text, innerBegin)).toEqual({
      open: { start: innerBegin, end: innerBeginEnd },
      close: { start: innerEnd, end: innerEndEnd },
    });
  });

  it("returns null when the caret touches neither \\begin nor \\end", () => {
    // A caret well inside the body text — not touching either token's range —
    // finds nothing (unlike a caret near either edge, which does).
    const text = "\\begin{a}hello world\\end{a}";
    const caret = text.indexOf("hello") + 2; // solidly inside "hello world"
    expect(findTexEnvDelimiterMatch(text, caret)).toBeNull();
  });

  it("returns null for an unbalanced \\begin", () => {
    expect(findTexEnvDelimiterMatch("\\begin{a}unclosed", 0)).toBeNull();
  });
});

describe("findTexDelimiterMatch", () => {
  it("prefers a math-delimiter match over an environment match", () => {
    const text = "\\begin{a}$x$\\end{a}";
    const dollarOpen = text.indexOf("$");
    const dollarClose = text.lastIndexOf("$");
    expect(findTexDelimiterMatch(text, dollarOpen)).toEqual({
      open: at(dollarOpen),
      close: at(dollarClose),
    });
  });

  it("falls back to the environment match when there's no math delimiter", () => {
    const text = "\\begin{a}x\\end{a}";
    const begin = 0;
    const beginEnd = text.indexOf("}", begin) + 1;
    const end = text.indexOf("\\end");
    const endEnd = text.indexOf("}", end) + 1;
    expect(findTexDelimiterMatch(text, begin)).toEqual({
      open: { start: begin, end: beginEnd },
      close: { start: end, end: endEnd },
    });
  });

  it("returns null when neither matcher finds anything", () => {
    expect(findTexDelimiterMatch("plain prose", 3)).toBeNull();
  });
});

/**
 * Coupled environment names: editing one half of a `\begin{env}…\end{env}` pair
 * renames the other in the same keystroke. The editor calls this with the draft
 * before and after a textarea change plus the live caret, so every case here is
 * written as "prev → next at caret".
 */
describe("syncTexEnvRename", () => {
  /** Type `insert` at `at` in `prev` — the shape a keystroke gives the caller. */
  function type(prev: string, at: number, insert: string) {
    const next = prev.slice(0, at) + insert + prev.slice(at);
    return { prev, next, caret: at + insert.length };
  }

  it("renames \\end when \\begin is typed into", () => {
    const prev = "\\begin{item}x\\end{item}";
    const { next, caret } = type(prev, prev.indexOf("{item}") + 5, "ize");
    const out = syncTexEnvRename(prev, next, caret)!;
    expect(out.text).toBe("\\begin{itemize}x\\end{itemize}");
    // The mirrored name sits after the caret, so the caret doesn't move.
    expect(out.caret).toBe(caret);
  });

  it("renames \\begin when \\end is typed into, shifting the caret", () => {
    const prev = "\\begin{item}x\\end{item}";
    const at = prev.lastIndexOf("{item}") + 5;
    const { next, caret } = type(prev, at, "ize");
    const out = syncTexEnvRename(prev, next, caret)!;
    expect(out.text).toBe("\\begin{itemize}x\\end{itemize}");
    // Three characters were inserted above the caret, so it follows them down.
    expect(out.caret).toBe(caret + 3);
    expect(out.text.slice(0, out.caret)).toBe("\\begin{itemize}x\\end{itemize");
  });

  it("mirrors a deletion, including down to an empty name", () => {
    const prev = "\\begin{ab}x\\end{ab}";
    const next = "\\begin{a}x\\end{ab}";
    expect(syncTexEnvRename(prev, next, "\\begin{a".length)!.text).toBe(
      "\\begin{a}x\\end{a}",
    );
    const empty = syncTexEnvRename("\\begin{a}x\\end{a}", "\\begin{}x\\end{a}", "\\begin{".length)!;
    expect(empty.text).toBe("\\begin{}x\\end{}");
  });

  it("picks the partner by nesting, not by the nearest same-named token", () => {
    const prev = "\\begin{a}\\begin{a}x\\end{a}\\end{a}";
    // Rename the INNER \begin: its partner is the FIRST \end, not the last.
    const at = prev.indexOf("\\begin{a}", 1) + "\\begin{a".length;
    const { next, caret } = type(prev, at, "b");
    expect(syncTexEnvRename(prev, next, caret)!.text).toBe(
      "\\begin{a}\\begin{ab}x\\end{ab}\\end{a}",
    );
  });

  it("leaves a pair that already disagreed alone", () => {
    const prev = "\\begin{a}x\\end{b}";
    const { next, caret } = type(prev, "\\begin{a".length, "z");
    expect(syncTexEnvRename(prev, next, caret)).toBeNull();
  });

  it("leaves an unpartnered \\begin alone", () => {
    const prev = "\\begin{a}x";
    const { next, caret } = type(prev, "\\begin{a".length, "b");
    expect(syncTexEnvRename(prev, next, caret)).toBeNull();
  });

  it("ignores an edit outside the name, or one reaching past its braces", () => {
    const prev = "\\begin{a}x\\end{a}";
    // Ordinary typing in the body.
    const body = type(prev, prev.indexOf("x"), "yz");
    expect(syncTexEnvRename(prev, body.next, body.caret)).toBeNull();
    // A replacement spanning the closing brace is not a rename.
    const wide = "\\begin{QQ x\\end{a}";
    expect(syncTexEnvRename(prev, wide, "\\begin{QQ".length)).toBeNull();
    // A find-and-replace touching both halves at once: one wide run, left alone.
    expect(syncTexEnvRename(prev, "\\begin{b}x\\end{b}", "\\begin{b".length)).toBeNull();
  });

  it("ignores a name edit the caret isn't in (an edit made elsewhere)", () => {
    const prev = "\\begin{a}x\\end{a}";
    const next = "\\begin{ab}x\\end{a}";
    expect(syncTexEnvRename(prev, next, next.length)).toBeNull();
  });

  it("returns null when nothing changed", () => {
    expect(syncTexEnvRename("\\begin{a}\\end{a}", "\\begin{a}\\end{a}", 3)).toBeNull();
  });
});

/**
 * The click-into-the-braces gesture: a caret between `\begin{`/`}` reports the
 * environment name's range, which the editor turns into a selection.
 */
describe("texEnvNameRangeAt", () => {
  const text = "\\begin{itemize}\nitem\n\\end{itemize}";
  const open = text.indexOf("itemize");
  const close = text.lastIndexOf("itemize");

  it("reports the name from anywhere between the braces, both ends included", () => {
    const range = { start: open, end: open + "itemize".length };
    expect(texEnvNameRangeAt(text, open)).toEqual(range); // just after `{`
    expect(texEnvNameRangeAt(text, open + 3)).toEqual(range); // mid-name
    expect(texEnvNameRangeAt(text, open + "itemize".length)).toEqual(range); // just before `}`
  });

  it("reports the \\end name too, not the \\begin one", () => {
    expect(texEnvNameRangeAt(text, close + 2)).toEqual({
      start: close,
      end: close + "itemize".length,
    });
  });

  it("reports nothing outside the braces", () => {
    expect(texEnvNameRangeAt(text, 0)).toBeNull(); // before `\\begin`
    expect(texEnvNameRangeAt(text, open - 1)).toBeNull(); // on `{`
    expect(texEnvNameRangeAt(text, text.indexOf("item\n") + 1)).toBeNull(); // body text
    expect(texEnvNameRangeAt("\\section{Intro}", 10)).toBeNull(); // not an environment
  });

  it("reports an empty range for a half-typed \\begin{}", () => {
    const empty = "\\begin{}";
    expect(texEnvNameRangeAt(empty, empty.length - 1)).toEqual({ start: 7, end: 7 });
  });
});

/**
 * Marking the partner NAME: with the caret (or the click-selection) inside one
 * environment name, the overlay marks the other one, so it is visible which
 * `\end` a rename is about to carry with it.
 */
describe("findTexEnvNameMatch", () => {
  it("marks both names from inside the \\begin name, and from inside the \\end name", () => {
    const text = "\\begin{itemize}\nx\n\\end{itemize}";
    const open = { start: text.indexOf("itemize"), end: text.indexOf("itemize") + 7 };
    const close = { start: text.lastIndexOf("itemize"), end: text.lastIndexOf("itemize") + 7 };
    expect(findTexEnvNameMatch(text, open.start + 2)).toEqual({ open, close });
    expect(findTexEnvNameMatch(text, close.start + 2)).toEqual({ open, close });
  });

  it("marks the partner while the two names still disagree (mid-rename)", () => {
    const text = "\\begin{itemi}x\\end{item}";
    const match = findTexEnvNameMatch(text, text.indexOf("itemi") + 5)!;
    expect(text.slice(match.open.start, match.open.end)).toBe("itemi");
    expect(text.slice(match.close.start, match.close.end)).toBe("item");
  });

  it("pairs by nesting, so the inner name marks the inner partner", () => {
    const text = "\\begin{a}\\begin{b}x\\end{b}\\end{a}";
    const inner = text.indexOf("{b}") + 1;
    const match = findTexEnvNameMatch(text, inner)!;
    expect(match.open.start).toBe(inner);
    expect(match.close.start).toBe(text.lastIndexOf("{b}") + 1);
  });

  it("still marks the partner while this side's name is empty", () => {
    const text = "\\begin{}x\\end{a}";
    const match = findTexEnvNameMatch(text, "\\begin{".length)!;
    expect(match.open).toEqual({ start: 7, end: 7 }); // nothing to paint here
    expect(text.slice(match.close.start, match.close.end)).toBe("a");
  });

  it("reports nothing outside a name, or for an unpartnered environment", () => {
    const text = "\\begin{a}x\\end{a}";
    expect(findTexEnvNameMatch(text, 0)).toBeNull(); // on the \\begin keyword
    expect(findTexEnvNameMatch(text, text.indexOf("x"))).toBeNull(); // body
    expect(findTexEnvNameMatch("\\begin{a}unclosed", 7)).toBeNull();
  });
});
