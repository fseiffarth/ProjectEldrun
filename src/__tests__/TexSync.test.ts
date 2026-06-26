/**
 * Unit tests for the SyncTeX helper math (#56) and the two cross-tab request
 * stores that carry forward/reverse-search results between the editor and PDF
 * tabs. All pure / store-level — no component rendering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  pdfPointToBigPoints,
  bigPointsToCssRect,
  lineStartOffset,
  offsetToLineCol,
  wordAt,
  phraseAt,
  refineToWord,
  forwardInputCandidates,
  pickSyncRect,
  pdfPageMatches,
  sourceColumnFraction,
  type SyncRect,
  type TextItemBox,
} from "../lib/viewers/tex";
import {
  useEditorJumpStore,
  hasMountedEditor,
  registerEditor,
  unregisterEditor,
} from "../stores/editorJump";
import { usePdfSyncStore } from "../stores/pdfSync";

describe("SyncTeX coordinate math", () => {
  it("pdfPointToBigPoints divides the in-rect offset by scale", () => {
    const rect = { left: 10, top: 20 };
    // At scale 2, a click 200px right / 100px down of the page origin is 100x50
    // big points.
    expect(pdfPointToBigPoints(rect, 210, 120, 2)).toEqual({ x: 100, y: 50 });
    // At scale 1 it is the raw offset.
    expect(pdfPointToBigPoints(rect, 30, 25, 1)).toEqual({ x: 20, y: 5 });
  });

  it("bigPointsToCssRect is the inverse mapping (multiply by scale)", () => {
    const css = bigPointsToCssRect({ page: 1, x: 100, y: 50, w: 200, h: 12 }, 2);
    expect(css).toEqual({ left: 200, top: 100, width: 400, height: 24 });
  });
});

describe("pdfPageMatches (#71 — Ctrl+F over a PDF page's text)", () => {
  // A single 11-char run "hello world" laid out 10 big points per character.
  const oneRun: TextItemBox[] = [{ str: "hello world", x: 0, y: 0, w: 110, h: 10 }];

  it("slices a single run to the matched character span", () => {
    // "world" is chars 6..11 → x 60, width 50.
    expect(pdfPageMatches(oneRun, 1, "world", false)).toEqual([
      [{ page: 1, x: 60, y: 0, w: 50, h: 10 }],
    ]);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    const run: TextItemBox[] = [{ str: "Hello", x: 0, y: 0, w: 50, h: 10 }];
    expect(pdfPageMatches(run, 1, "hello", false)).toEqual([
      [{ page: 1, x: 0, y: 0, w: 50, h: 10 }],
    ]);
    expect(pdfPageMatches(run, 1, "hello", true)).toEqual([]);
  });

  it("returns one box per run a match straddles", () => {
    const runs: TextItemBox[] = [
      { str: "foo", x: 0, y: 0, w: 30, h: 10 },
      { str: "bar", x: 30, y: 0, w: 30, h: 10 },
    ];
    // "ooba" spans the join: "oo" in run 0 (x 10, w 20) + "ba" in run 1 (x 30, w 20).
    expect(pdfPageMatches(runs, 2, "ooba", false)).toEqual([
      [
        { page: 2, x: 10, y: 0, w: 20, h: 10 },
        { page: 2, x: 30, y: 0, w: 20, h: 10 },
      ],
    ]);
  });

  it("finds every non-overlapping occurrence", () => {
    const run: TextItemBox[] = [{ str: "aaaa", x: 0, y: 0, w: 40, h: 10 }];
    const out = pdfPageMatches(run, 1, "aa", false);
    expect(out).toEqual([
      [{ page: 1, x: 0, y: 0, w: 20, h: 10 }],
      [{ page: 1, x: 20, y: 0, w: 20, h: 10 }],
    ]);
  });

  it("yields nothing for an empty query or no hit", () => {
    expect(pdfPageMatches(oneRun, 1, "", false)).toEqual([]);
    expect(pdfPageMatches(oneRun, 1, "zzz", false)).toEqual([]);
  });
});

describe("sourceColumnFraction (caret position along its source line)", () => {
  const text = "hello world foo\nsecond line here\n";

  it("maps the 1-based column to a [0,1] fraction of the line length", () => {
    // Line 1 is "hello world foo" (15 chars). Column 1 → start, column 16 → end.
    expect(sourceColumnFraction(text, 1, 1)).toBe(0);
    expect(sourceColumnFraction(text, 1, 16)).toBe(1);
    expect(sourceColumnFraction(text, 1, 9)).toBeCloseTo(8 / 15);
  });

  it("uses the targeted line's own length (not the whole text)", () => {
    // Line 2 is "second line here" (16 chars); column 9 → 8/16.
    expect(sourceColumnFraction(text, 2, 9)).toBeCloseTo(0.5);
  });

  it("clamps out-of-range columns and treats a blank/1-char line as 0", () => {
    expect(sourceColumnFraction(text, 1, 999)).toBe(1); // past the end clamps to 1
    expect(sourceColumnFraction(text, 1, -5)).toBe(0); // before the start clamps to 0
    expect(sourceColumnFraction("x\ny", 1, 1)).toBe(0); // a 1-char line has no spread
  });
});

describe("pickSyncRect (choose the SyncTeX record under the clicked column)", () => {
  it("returns the only record (or null for none) without weighing fractions", () => {
    expect(pickSyncRect([], 0.5)).toBeNull();
    const one: SyncRect = { page: 1, x: 10, y: 20, w: 30, h: 12 };
    expect(pickSyncRect([one], 0.9)).toBe(one);
  });

  it("picks the box covering the column's share of the line's width", () => {
    // Three equal boxes tiling one row: fractions 0..⅓ → first, ⅓..⅔ → second, …
    const recs: SyncRect[] = [
      { page: 1, x: 0, y: 100, w: 100, h: 12 },
      { page: 1, x: 100, y: 100, w: 100, h: 12 },
      { page: 1, x: 200, y: 100, w: 100, h: 12 },
    ];
    expect(pickSyncRect(recs, 0.1)!.x).toBe(0);
    expect(pickSyncRect(recs, 0.5)!.x).toBe(100);
    expect(pickSyncRect(recs, 0.9)!.x).toBe(200);
  });

  it("reads top-to-bottom so a wrapped line's late column lands on the lower row", () => {
    // A source line wrapped to two rows; the records may arrive out of order.
    const recs: SyncRect[] = [
      { page: 1, x: 0, y: 130, w: 100, h: 12 }, // lower row, listed first
      { page: 1, x: 0, y: 100, w: 100, h: 12 }, // upper row
    ];
    // Early in the line → upper row; late → the wrapped lower row.
    expect(pickSyncRect(recs, 0.2)!.y).toBe(100);
    expect(pickSyncRect(recs, 0.8)!.y).toBe(130);
  });

  it("treats zero-width boxes as one unit so it never divides by zero", () => {
    const recs: SyncRect[] = [
      { page: 1, x: 0, y: 100, w: 0, h: 12 },
      { page: 1, x: 5, y: 100, w: 0, h: 12 },
    ];
    expect(pickSyncRect(recs, 0)!.x).toBe(0);
    expect(pickSyncRect(recs, 1)!.x).toBe(5);
  });
});

describe("editor line/offset helpers", () => {
  const text = "alpha\nbeta\ngamma\n";

  it("lineStartOffset returns the char offset of a 1-based line start", () => {
    expect(lineStartOffset(text, 1)).toBe(0);
    expect(lineStartOffset(text, 2)).toBe(6); // after "alpha\n"
    expect(lineStartOffset(text, 3)).toBe(11); // after "beta\n"
    // Past the end clamps to the text length.
    expect(lineStartOffset(text, 99)).toBe(text.length);
  });

  it("offsetToLineCol is the inverse of lineStartOffset for line starts", () => {
    expect(offsetToLineCol(text, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineCol(text, 6)).toEqual({ line: 2, column: 1 });
    // Mid-line: column counts from the line start (1-based).
    expect(offsetToLineCol(text, 8)).toEqual({ line: 2, column: 3 });
  });
});

describe("wordAt (word under the caret)", () => {
  const text = "the quick brown fox";

  it("returns the whole word the caret sits inside", () => {
    expect(wordAt(text, 6)).toBe("quick"); // caret mid-"quick"
    expect(wordAt(text, 4)).toBe("quick"); // caret at the word start
    expect(wordAt(text, 9)).toBe("quick"); // caret at the word end
  });

  it("returns null on whitespace and out-of-range carets", () => {
    expect(wordAt("a  b", 2)).toBeNull(); // between two spaces — no adjacent word
    expect(wordAt(text, -1)).toBeNull();
    expect(wordAt(text, 999)).toBeNull();
  });

  it("returns the word when the caret sits right after it (word end)", () => {
    expect(wordAt(text, 3)).toBe("the"); // caret just past "the"
  });

  it("keeps internal hyphens/apostrophes but trims trailing connectors", () => {
    expect(wordAt("a state-of-the-art b", 8)).toBe("state-of-the-art");
    expect(wordAt("don't stop", 2)).toBe("don't");
    expect(wordAt("word- next", 2)).toBe("word"); // trailing hyphen trimmed
  });

  it("returns null when the caret is on a lone connector / punctuation", () => {
    expect(wordAt("a -- b", 3)).toBeNull();
    expect(wordAt("\\section{x}", 0)).toBeNull(); // on the backslash
  });
});

describe("phraseAt (clicked word + same-line neighbours)", () => {
  it("returns the clicked word with neighbours and its index", () => {
    const src = "the quick brown fox jumps";
    // caret in "brown" (index 10..15).
    expect(phraseAt(src, 12, 2)).toEqual({
      words: ["the", "quick", "brown", "fox", "jumps"],
      index: 2,
      lineIndex: 2,
    });
  });

  it("limits neighbours to the radius and stays on the source line", () => {
    const src = "a b c target d e f\nother line";
    const caret = src.indexOf("target") + 2;
    const p = phraseAt(src, caret, 2);
    // The phrase `index` is capped to the radius, but `lineIndex` stays uncapped:
    // "target" is the 4th word (3 words ahead) on its line.
    expect(p).toEqual({ words: ["b", "c", "target", "d", "e"], index: 2, lineIndex: 3 });
  });

  it("strips TeX markup from neighbours but keeps the clicked word", () => {
    const src = "see \\emph{the} \\textbf{framework} now";
    const caret = src.indexOf("framework") + 3;
    const p = phraseAt(src, caret, 3)!;
    // \emph and \textbf are dropped; only natural words remain.
    expect(p.words).toEqual(["see", "the", "framework", "now"]);
    expect(p.words[p.index]).toBe("framework");
  });

  it("returns null when the caret isn't on a word", () => {
    expect(phraseAt("a -- b", 3, 3)).toBeNull();
  });
});

describe("refineToWord (narrow a SyncTeX box to the clicked word)", () => {
  // A SyncTeX line box spanning a line at y≈100, height 12.
  const target = { page: 1, x: 0, y: 100, w: 400, h: 12 };

  it("returns a tight box around the clicked word's share of its run", () => {
    // One run "hello world" 220 wide at the target line: 11 chars → 20/char.
    const items: TextItemBox[] = [{ str: "hello world", x: 50, y: 100, w: 220, h: 12 }];
    const r = refineToWord(target, { words: ["hello", "world"], index: 1 }, items);
    expect(r).not.toBeNull();
    const charW = 220 / 11;
    expect(r!.page).toBe(1);
    expect(r!.x).toBeCloseTo(50 + 6 * charW); // "world" starts at index 6
    expect(r!.w).toBeCloseTo(5 * charW);
    expect(r!.y).toBe(100);
    expect(r!.h).toBe(12);
  });

  it("boxes the word's core, trimming attached punctuation/quotes", () => {
    // One run "(framework)," 120 wide: 12 chars → 10/char. The box must hug
    // "framework" (1 leading "(", 2 trailing ")," shaved), not the punctuation.
    const items: TextItemBox[] = [{ str: "(framework),", x: 50, y: 100, w: 120, h: 12 }];
    const r = refineToWord(target, { words: ["framework"], index: 0 }, items);
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(50 + 10); // skip the leading "("
    expect(r!.w).toBeCloseTo(9 * 10); // 9 letters, not the full 12-char token
  });

  it("picks the occurrence nearest the target line, not on another line", () => {
    const items: TextItemBox[] = [
      { str: "fox", x: 0, y: 300, w: 30, h: 12 }, // far line
      { str: "fox", x: 10, y: 100, w: 30, h: 12 }, // the target line
    ];
    const r = refineToWord(target, { words: ["fox"], index: 0 }, items);
    expect(r!.y).toBe(100);
    expect(r!.x).toBeCloseTo(10);
  });

  it("uses the surrounding phrase to disambiguate a repeated word on the line", () => {
    // "the" appears twice on the target line; the phrase "brown the fox" should
    // pick the SECOND one (preceded by "brown", followed by "fox").
    const items: TextItemBox[] = [
      { str: "the", x: 0, y: 100, w: 30, h: 12 },
      { str: "cat", x: 40, y: 100, w: 30, h: 12 },
      { str: "brown", x: 80, y: 100, w: 50, h: 12 },
      { str: "the", x: 140, y: 100, w: 30, h: 12 }, // the intended one
      { str: "fox", x: 180, y: 100, w: 30, h: 12 },
    ];
    const r = refineToWord(target, { words: ["brown", "the", "fox"], index: 1 }, items);
    expect(r!.x).toBeCloseTo(140);
  });

  it("breaks a repeated-phrase tie by the clicked word's source-line position", () => {
    // The whole phrase "see the cat" repeats on the line, so neighbour matching
    // ties on both "the"s. Only the source-line ordinal (lineIndex) distinguishes
    // them: clicking the SECOND "the" (the 5th word, lineIndex 4) must box the
    // second occurrence, not whichever sits nearer the line centre.
    const items: TextItemBox[] = [
      { str: "see", x: 0, y: 100, w: 30, h: 12 },
      { str: "the", x: 40, y: 100, w: 30, h: 12 }, // first "the" (col 1)
      { str: "cat", x: 80, y: 100, w: 30, h: 12 },
      { str: "see", x: 120, y: 100, w: 30, h: 12 },
      { str: "the", x: 160, y: 100, w: 30, h: 12 }, // second "the" (col 4) — intended
      { str: "cat", x: 200, y: 100, w: 30, h: 12 },
    ];
    const phrase = { words: ["see", "the", "cat"], index: 1, lineIndex: 4 };
    const r = refineToWord(target, phrase, items);
    expect(r!.x).toBeCloseTo(160);

    // Clicking the FIRST "the" (lineIndex 1) boxes the first occurrence instead.
    const first = refineToWord(target, { ...phrase, lineIndex: 1 }, items);
    expect(first!.x).toBeCloseTo(40);
  });

  it("keeps phrase context above position when the two disagree", () => {
    // Position alone would prefer the first "the" (col 1, nearer lineIndex 1), but
    // the phrase context "red the box" only fits the second — context must win, so
    // the source-line ordinal stays a tiebreak, not an override.
    const items: TextItemBox[] = [
      { str: "the", x: 0, y: 100, w: 30, h: 12 }, // col 0 — no surrounding context
      { str: "x", x: 40, y: 100, w: 10, h: 12 },
      { str: "red", x: 60, y: 100, w: 30, h: 12 },
      { str: "the", x: 100, y: 100, w: 30, h: 12 }, // col 3 — "red … box" around it
      { str: "box", x: 140, y: 100, w: 30, h: 12 },
    ];
    const r = refineToWord(target, { words: ["red", "the", "box"], index: 1, lineIndex: 0 }, items);
    expect(r!.x).toBeCloseTo(100);
  });

  it("falls back to the phrase index when no lineIndex is supplied", () => {
    // A bare {words, index} (older callers / tests) still resolves: with the
    // phrase context differing, the contextful occurrence wins regardless.
    const items: TextItemBox[] = [
      { str: "red", x: 0, y: 100, w: 30, h: 12 },
      { str: "box", x: 40, y: 100, w: 30, h: 12 }, // no "the" before/after
      { str: "the", x: 80, y: 100, w: 30, h: 12 },
      { str: "the", x: 120, y: 100, w: 30, h: 12 }, // preceded by "the" → context match
    ];
    const r = refineToWord(target, { words: ["the", "the"], index: 1 }, items);
    expect(r!.x).toBeCloseTo(120);
  });

  it("lets phrase context override a wrong target row on a wrapped line", () => {
    // A repeated word ("relabeling") on ONE source line that wrapped to two PDF
    // rows. pickSyncRect, tiling by visual width, guessed the LOWER row (target
    // y=120) for a click on the FIRST occurrence — so trusting the row alone would
    // box the second. The surrounding phrase fits only the first occurrence, so it
    // must win despite sitting on the other row.
    const wrapTarget = { page: 1, x: 0, y: 120, w: 200, h: 12 };
    const items: TextItemBox[] = [
      // upper row: "... insensitive to node relabeling whereas gat"
      { str: "insensitive", x: 0, y: 100, w: 90, h: 12 },
      { str: "to", x: 95, y: 100, w: 20, h: 12 },
      { str: "node", x: 120, y: 100, w: 40, h: 12 },
      { str: "relabeling", x: 165, y: 100, w: 80, h: 12 }, // intended (first)
      { str: "whereas", x: 250, y: 100, w: 60, h: 12 },
      { str: "gat", x: 315, y: 100, w: 30, h: 12 },
      // lower row (the wrongly-picked target row): "... sensitive to node relabeling"
      { str: "sensitive", x: 0, y: 120, w: 80, h: 12 },
      { str: "to", x: 85, y: 120, w: 20, h: 12 },
      { str: "node", x: 110, y: 120, w: 40, h: 12 },
      { str: "relabeling", x: 155, y: 120, w: 80, h: 12 }, // second
    ];
    const phrase = {
      words: ["insensitive", "to", "node", "relabeling", "whereas", "gat"],
      index: 3,
      lineIndex: 3,
    };
    const r = refineToWord(wrapTarget, phrase, items);
    expect(r!.y).toBe(100); // the upper row — the first occurrence
    expect(r!.x).toBeCloseTo(165);
  });

  it("prefers a whole word over a substring buried in another token", () => {
    const items: TextItemBox[] = [
      { str: "binding", x: 0, y: 100, w: 70, h: 12 }, // contains "in" as substring
      { str: "in", x: 200, y: 100, w: 20, h: 12 }, // standalone word
    ];
    const r = refineToWord(target, { words: ["in"], index: 0 }, items);
    expect(r!.x).toBeCloseTo(200);
  });

  it("returns null when the clicked word is absent", () => {
    const items: TextItemBox[] = [{ str: "nothing here", x: 0, y: 100, w: 100, h: 12 }];
    expect(refineToWord(target, { words: ["absent"], index: 0 }, items)).toBeNull();
  });
});

describe("forwardInputCandidates (SyncTeX forward-search path spellings)", () => {
  it("yields absolute, build-dir-relative, and basename spellings (+ ./ forms)", () => {
    expect(forwardInputCandidates("/proj/paper/main.tex", "/proj/paper")).toEqual([
      "/proj/paper/main.tex",
      "main.tex",
      "./main.tex",
      // basename equals the relative form here, so its duplicates are deduped.
    ]);
  });

  it("keeps a nested relative path distinct from the basename", () => {
    expect(
      forwardInputCandidates("/proj/paper/chapters/intro.tex", "/proj/paper/"),
    ).toEqual([
      "/proj/paper/chapters/intro.tex",
      "chapters/intro.tex",
      "./chapters/intro.tex",
      "intro.tex",
      "./intro.tex",
    ]);
  });

  it("falls back to absolute + basename when the file is outside the build dir", () => {
    expect(forwardInputCandidates("/other/x.tex", "/proj/paper")).toEqual([
      "/other/x.tex",
      "x.tex",
      "./x.tex",
    ]);
  });
});

describe("editorJump store", () => {
  beforeEach(() => useEditorJumpStore.setState({ requestsByPath: {} }));

  it("records a jump with an incrementing nonce, and consume clears it", () => {
    const { requestJump } = useEditorJumpStore.getState();
    requestJump("/p/a.tex", 12);
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"]).toEqual({
      line: 12,
      column: 0,
      nonce: 1,
    });
    // A repeat jump to the same file bumps the nonce so it re-fires.
    requestJump("/p/a.tex", 12);
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"].nonce).toBe(2);

    useEditorJumpStore.getState().consume("/p/a.tex");
    expect(useEditorJumpStore.getState().requestsByPath["/p/a.tex"]).toBeUndefined();
  });

  it("applyJump records a jump without needing a Tauri event bus", () => {
    // requestJump also broadcasts (#42); applyJump is the local-only half the
    // cross-window listener calls. Outside Tauri the broadcast is a no-op, so
    // both must still record locally.
    useEditorJumpStore.getState().applyJump("/p/b.tex", 7, 3);
    expect(useEditorJumpStore.getState().requestsByPath["/p/b.tex"]).toEqual({
      line: 7,
      column: 3,
      nonce: 1,
    });
  });
});

describe("mounted-editor registry (reverse-search window targeting, #42)", () => {
  it("ref-counts so a path stays mounted until every editor unmounts", () => {
    expect(hasMountedEditor("/p/c.tex")).toBe(false);
    registerEditor("/p/c.tex");
    registerEditor("/p/c.tex"); // same path open in two panes of this window
    expect(hasMountedEditor("/p/c.tex")).toBe(true);
    unregisterEditor("/p/c.tex");
    // One editor still mounted — must remain "open" so a jump scrolls it here
    // rather than being delegated to the main window.
    expect(hasMountedEditor("/p/c.tex")).toBe(true);
    unregisterEditor("/p/c.tex");
    expect(hasMountedEditor("/p/c.tex")).toBe(false);
    // A stray unregister past zero is harmless.
    unregisterEditor("/p/c.tex");
    expect(hasMountedEditor("/p/c.tex")).toBe(false);
  });
});

describe("pdfSync store", () => {
  beforeEach(() => usePdfSyncStore.setState({ byPath: {} }));

  it("records a reveal with a strictly-increasing nonce, and consume clears it", () => {
    const rect = { page: 2, x: 1, y: 2, w: 3, h: 4 };
    usePdfSyncStore.getState().requestReveal("/p/a.pdf", rect);
    const first = usePdfSyncStore.getState().byPath["/p/a.pdf"];
    expect(first).toMatchObject({ rect });

    // The nonce is monotonic (never resets), so a repeat reveal always re-fires.
    usePdfSyncStore.getState().requestReveal("/p/a.pdf", rect);
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"].nonce).toBe(first.nonce + 1);

    usePdfSyncStore.getState().consume("/p/a.pdf");
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"]).toBeUndefined();

    // Even after consume deletes the entry, the next reveal's nonce keeps climbing
    // (the "works only once" fix) rather than resetting to 1.
    usePdfSyncStore.getState().requestReveal("/p/a.pdf", rect);
    expect(usePdfSyncStore.getState().byPath["/p/a.pdf"].nonce).toBe(first.nonce + 2);
  });

  it("carries the clicked phrase through to the reveal request", () => {
    const rect = { page: 1, x: 1, y: 2, w: 3, h: 4 };
    const phrase = { words: ["the", "framework", "now"], index: 1 };
    usePdfSyncStore.getState().requestReveal("/p/b.pdf", rect, phrase);
    expect(usePdfSyncStore.getState().byPath["/p/b.pdf"]).toMatchObject({ rect, phrase });
  });
});
