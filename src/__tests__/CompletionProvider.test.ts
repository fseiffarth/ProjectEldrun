import { describe, expect, it } from "vitest";
import { CompletionAcceptance, inlineCandidate, offsetToPosition, positionToOffset,
  type CompletionDocument } from "../lib/viewers/completionProvider";

function doc(text: string, caret = text.length): CompletionDocument {
  return { path: "/project/example.ts", version: 7, text, caret, language: "typescript" };
}

describe("language-server completion positions", () => {
  it("round-trips UTF-16 positions with CRLF without splitting surrogate pairs", () => {
    const text = "a😀\r\nβx\n";
    expect(offsetToPosition(text, 3)).toEqual({ line: 0, character: 3 });
    expect(offsetToPosition(text, 6)).toEqual({ line: 1, character: 1 });
    for (const offset of [0, 1, 3, 5, 6, 7, 8]) {
      expect(positionToOffset(text, offsetToPosition(text, offset)!)).toBe(offset);
    }
    expect(offsetToPosition(text, 2)).toBeNull();
    expect(offsetToPosition(text, 4)).toBeNull();
    for (const position of [{ line: 0, character: 2 }, { line: 0, character: 4 },
      { line: -1, character: 0 }, { line: 3, character: 0 }, { line: 1, character: 0.5 }]) {
      expect(positionToOffset(text, position)).toBeNull();
    }
  });
});

describe("safe ghost insertions", () => {
  it("keeps opaque item identity and strips an unchanged replacement prefix/suffix", () => {
    const document = doc("console.()", 8);
    const item = { insertText: "console.log()", range: {
      start: { line: 0, character: 0 }, end: { line: 0, character: 10 },
    }, command: { command: "github.copilot.didAcceptCompletionItem", arguments: ["opaque"] }, extra: "preserved" };
    const candidate = inlineCandidate(document, item, "session/item")!;
    expect(candidate).toMatchObject({ text: "log", at: 8, version: 7, acceptedPrefix: 8 });
    expect(candidate.original).toBe(item);
  });

  it("rejects deletions, rewrites, edits away from the caret and empty insertions", () => {
    const document = doc("abc()", 3);
    for (const insertText of ["abx()", "ab()", "abc[]", "abc()", "abc("]) {
      expect(inlineCandidate(document, { insertText, range: {
        start: { line: 0, character: 0 }, end: { line: 0, character: 5 },
      } }, "id")).toBeNull();
    }
    expect(inlineCandidate(document, { insertText: "xyz", range: {
      start: { line: 0, character: 0 }, end: { line: 0, character: 1 },
    } }, "id")).toBeNull();
  });

  it("normalizes newline forms while measuring feedback against the original item", () => {
    const document = doc("x\r\nreturn ");
    const item = { insertText: "return 😀\nnext()", range: {
      start: { line: 1, character: 0 }, end: { line: 1, character: 7 },
    } };
    const candidate = inlineCandidate(document, item, "id")!;
    expect(candidate.text).toBe("😀\r\nnext()");
    const feedback = new CompletionAcceptance(candidate);
    expect(feedback.accept("😀")).toEqual({ full: false, acceptedLength: 9 });
    expect(feedback.accept("\r\n")).toEqual({ full: false, acceptedLength: 10 });
    expect(feedback.accept("wrong")).toBeNull();
    expect(feedback.accept("next()")).toEqual({ full: true, acceptedLength: 16 });
    expect(feedback.accept("next()")).toBeNull();
  });

  it("includes a multiline replacement prefix in partial acceptance offsets", () => {
    const document = doc("first\nsecond ");
    const candidate = inlineCandidate(document, { insertText: "first\r\nsecond foo bar", range: {
      start: { line: 0, character: 0 }, end: { line: 1, character: 7 },
    } }, "id")!;
    expect(candidate.acceptedPrefix).toBe(14);
    const feedback = new CompletionAcceptance(candidate);
    expect(feedback.accept("foo")).toEqual({ full: false, acceptedLength: 17 });
    expect(feedback.accept(" bar")).toEqual({ full: true, acceptedLength: 21 });
  });
});
