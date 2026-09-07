/**
 * Tests for the TeX editor's beamer mode (#tex-beamer), the pure half
 * (`lib/viewers/beamer.ts`):
 *  - overlay spec recognition and the from/to/onward builder;
 *  - beamer-class detection (comments ignored);
 *  - wrapping a selection, re-targeting an already wrapped one, the
 *    multi-argument commands, and the trailing newline staying outside;
 *  - stamping `\item`s counting up, `\pause`, the next free slide number;
 *  - which range the bar edits when the live selection has collapsed.
 */
import { describe, it, expect } from "vitest";
import {
  beamerEditRange,
  buildOverlaySpec,
  frameBoundsAt,
  insertPause,
  isBeamerDocument,
  isOverlaySpecBody,
  nextOverlayNumber,
  overlayCommandAround,
  overlayItems,
  overlaySpecAt,
  overlaySpecsIn,
  parseOverlayCommandAt,
  wrapBeamerOverlay,
} from "../lib/viewers/beamer";

describe("overlay specs", () => {
  it("accepts the beamer grammar and refuses what cannot be a spec", () => {
    for (const ok of ["2", "2-", "-3", "1-3", "1,3-5", "+-", ".-", "+(1)-", "1-| alert@2", "handout:0", "beamer:2-"]) {
      expect(isOverlaySpecBody(ok), ok).toBe(true);
    }
    for (const bad of ["", "a", "x<y", "{1}", "\\alpha", "1".repeat(61)]) {
      expect(isOverlaySpecBody(bad), bad).toBe(false);
    }
  });

  it("reads a spec at a position, and only there", () => {
    expect(overlaySpecAt("\\only<2->{x}", 5)).toEqual({ body: "2-", end: 9 });
    expect(overlaySpecAt("\\only<2->{x}", 4)).toBeNull();
    expect(overlaySpecAt("a<b>", 1)).toBeNull(); // no digit, +, or .
    expect(overlaySpecAt("<1\n2>", 0)).toBeNull(); // never across a line
  });

  it("builds a spec from the bar's fields", () => {
    expect(buildOverlaySpec(2, null, false)).toBe("2");
    expect(buildOverlaySpec(2, null, true)).toBe("2-");
    expect(buildOverlaySpec(2, 4, false)).toBe("2-4");
    expect(buildOverlaySpec(4, 2, false)).toBe("2-4");
    expect(buildOverlaySpec(3, 3, false)).toBe("3");
    expect(buildOverlaySpec(null, 3, false)).toBe("-3");
    expect(buildOverlaySpec(null, null, true)).toBe("");
    expect(isOverlaySpecBody(buildOverlaySpec(null, null, true))).toBe(false);
  });

  it("finds every spec in a frame, skipping comments", () => {
    const src = "\\begin{frame}<1->\n\\item<2-> a % \\only<9>{c}\n\\begin{itemize}[<+->]\n\\alert<3>{b}";
    expect(overlaySpecsIn(src).map((s) => s.body)).toEqual(["1-", "2-", "+-", "3"]);
  });
});

describe("isBeamerDocument", () => {
  it("detects the class with and without options, ignoring comments", () => {
    expect(isBeamerDocument("\\documentclass{beamer}")).toBe(true);
    expect(isBeamerDocument("\\documentclass[aspectratio=169,t]{ beamer }")).toBe(true);
    expect(isBeamerDocument("\\documentclass{article}\n% \\documentclass{beamer}")).toBe(false);
    expect(isBeamerDocument("50\\% \\documentclass{beamer}")).toBe(true);
  });
});

describe("wrapBeamerOverlay", () => {
  it("wraps a selection and selects the body", () => {
    const v = "see this here";
    const r = wrapBeamerOverlay(v, 4, 8, "only", "2-");
    expect(r.value).toBe("see \\only<2->{this} here");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("this");
  });

  it("leaves the caret inside empty braces when nothing is selected", () => {
    const r = wrapBeamerOverlay("ab", 1, 1, "uncover", "3");
    expect(r.value).toBe("a\\uncover<3>{}b");
    expect(r.selStart).toBe("a\\uncover<3>{".length);
    expect(r.selEnd).toBe(r.selStart);
  });

  it("keeps a line-wise selection's trailing newline outside the braces", () => {
    const r = wrapBeamerOverlay("line one\nline two\n", 0, 9, "visible", "2");
    expect(r.value).toBe("\\visible<2>{line one}\nline two\n");
  });

  it("re-targets the command and spec when the selection is already a wrapped body", () => {
    const v = "x \\only<2>{word} y";
    const s = v.indexOf("word");
    const r = wrapBeamerOverlay(v, s, s + 4, "uncover", "3-");
    expect(r.value).toBe("x \\uncover<3->{word} y");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("word");
  });

  it("re-targets when the whole command is selected", () => {
    const v = "x \\only<2>{word} y";
    const r = wrapBeamerOverlay(v, 2, v.indexOf(" y"), "alert", "4");
    expect(r.value).toBe("x \\alert<4>{word} y");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("\\alert<4>{word}");
  });

  it("nests rather than re-targets across arities", () => {
    const v = "\\only<2>{word}";
    const r = wrapBeamerOverlay(v, 9, 13, "alt", "3");
    expect(r.value).toBe("\\only<2>{\\alt<3>{word}{}}");
  });

  it("puts \\alt's selection first and the caret in the empty second argument", () => {
    const r = wrapBeamerOverlay("ab cd", 0, 2, "alt", "2");
    expect(r.value).toBe("\\alt<2>{ab}{} cd");
    expect(r.selStart).toBe("\\alt<2>{ab}{".length);
    expect(r.selEnd).toBe(r.selStart);
  });

  it("puts \\temporal's selection in the middle and the caret in the first", () => {
    const r = wrapBeamerOverlay("ab", 0, 2, "temporal", "2");
    expect(r.value).toBe("\\temporal<2>{}{ab}{}");
    expect(r.selStart).toBe("\\temporal<2>{".length);
    expect(r.selEnd).toBe(r.selStart);
  });

  it("re-targets a multi-argument command from its second argument", () => {
    const v = "\\alt<2>{on}{off}";
    const s = v.indexOf("off");
    const around = overlayCommandAround(v, s, s + 3);
    expect(around?.argIndex).toBe(1);
    const r = wrapBeamerOverlay(v, s, s + 3, "alt", "3-");
    expect(r.value).toBe("\\alt<3->{on}{off}");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("off");
  });

  it("parses a command with escaped braces in its argument", () => {
    const v = "\\only<2>{a\\}b}";
    expect(parseOverlayCommandAt(v, 0)).toEqual({
      cmd: "only",
      spec: "2",
      args: [{ start: 9, end: 13 }],
      end: 14,
    });
    expect(parseOverlayCommandAt("\\textbf<2>{x}", 0)).toBeNull();
    expect(parseOverlayCommandAt("\\alt<2>{x}", 0)).toBeNull(); // missing second argument
  });
});

describe("overlayItems", () => {
  const list = "\\begin{itemize}\n  \\item one\n  \\item<9> two\n  \\item three\n\\end{itemize}\n";

  it("stamps the selected lines' items counting up from the first slide", () => {
    const s = list.indexOf("\\item one");
    const e = list.indexOf("three") + 5;
    const r = overlayItems(list, s, e, "2-")!;
    expect(r.value).toBe(
      "\\begin{itemize}\n  \\item<2-> one\n  \\item<3-> two\n  \\item<4-> three\n\\end{itemize}\n",
    );
    expect(r.value.slice(r.selStart, r.selEnd)).toBe(
      "  \\item<2-> one\n  \\item<3-> two\n  \\item<4-> three",
    );
  });

  it("steps both ends of a range and stamps a relative spec as is", () => {
    const s = list.indexOf("\\item one");
    const e = list.indexOf("three");
    expect(overlayItems(list, s, e, "1-2")!.value).toContain("\\item<1-2> one\n  \\item<2-3> two\n  \\item<3-4> three");
    expect(overlayItems(list, s, e, "+-")!.value).toContain("\\item<+-> one\n  \\item<+-> two\n  \\item<+-> three");
  });

  it("acts on the caret's line alone and reports lines without an item", () => {
    const at = list.indexOf("two");
    expect(overlayItems(list, at, at, "2")!.value).toContain("\\item<2> two");
    expect(overlayItems(list, 0, 0, "2")).toBeNull();
    // A line-wise selection of the first line only: its trailing newline does
    // not drag the item line below into the range.
    expect(overlayItems(list, 0, list.indexOf("\n") + 1, "2")).toBeNull();
  });

  it("does not stamp \\itemsep or another word starting with item", () => {
    expect(overlayItems("\\itemsep 2pt", 0, 0, "2")).toBeNull();
  });
});

describe("insertPause", () => {
  it("goes on its own line", () => {
    expect(insertPause("a\nb", 2, 2)).toEqual({ value: "a\n\\pause\nb", selStart: 8, selEnd: 8 });
    expect(insertPause("a\nb", 1, 1).value).toBe("a\n\\pause\nb");
    expect(insertPause("a\n", 2, 2).value).toBe("a\n\\pause");
    expect(insertPause("ab", 1, 1).value).toBe("a\n\\pause\nb");
  });
});

describe("nextOverlayNumber", () => {
  const deck =
    "\\begin{frame}\n\\only<2>{a} \\uncover<3->{b}\n\\end{frame}\n\\begin{frame}\n\\item<2-> c\n\\end{frame}\n";

  it("is one past the largest number in the enclosing frame only", () => {
    expect(nextOverlayNumber(deck, deck.indexOf("{a}"))).toBe(4);
    expect(nextOverlayNumber(deck, deck.indexOf(" c"))).toBe(3);
  });

  it("starts at 2 in a frame without overlays, and bounds the frame", () => {
    const src = "\\begin{frame}\nplain\n\\end{frame}\n";
    expect(nextOverlayNumber(src, src.indexOf("plain"))).toBe(2);
    expect(frameBoundsAt(src, src.indexOf("plain"))).toEqual({
      start: 0,
      end: src.indexOf("\\end{frame}"),
    });
    expect(frameBoundsAt("no frames", 3)).toEqual({ start: 0, end: 9 });
  });
});

describe("beamerEditRange", () => {
  it("prefers a live selection, falls back to a remembered one that still matches", () => {
    expect(beamerEditRange("hello world", 0, 5, { start: 6, end: 11, text: "world" })).toEqual({ start: 0, end: 5 });
    expect(beamerEditRange("hello world", 0, 0, { start: 6, end: 11, text: "world" })).toEqual({ start: 6, end: 11 });
  });

  it("ignores a remembered selection the draft has moved under", () => {
    expect(beamerEditRange("hello there", 3, 3, { start: 6, end: 11, text: "world" })).toEqual({ start: 3, end: 3 });
    expect(beamerEditRange("hi", 1, 1, { start: 6, end: 11, text: "world" })).toEqual({ start: 1, end: 1 });
    expect(beamerEditRange("hi", 1, 1, null)).toEqual({ start: 1, end: 1 });
  });
});
