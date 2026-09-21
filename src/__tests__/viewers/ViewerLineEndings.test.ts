/**
 * The editor's line-ending contract (`lib/viewers/fileUtils`).
 *
 * Why this exists: the editor is a `<textarea>` and the pane reads `el.value`,
 * whose API value the HTML spec normalizes to LF. So the first keystroke
 * anywhere in a CRLF file silently rewrote EVERY line ending in the buffer and
 * the save wrote LF throughout — a one-character edit producing a whole-file
 * diff, in every text viewer at once. The fix holds the buffer in LF by
 * construction (so `yaml.ts`, `table.ts` and `bib.ts` all splice against one
 * convention instead of a buffer that changes under them) and restores the
 * file's own ending at the single point bytes leave `useEditableFile`.
 *
 * These two helpers are that contract. The idempotence case is the load-bearing
 * one: the same function runs over a buffer that is still the raw seed (file
 * endings intact) and over one the textarea has already normalized.
 */
import { describe, expect, it } from "vitest";
import { applyLineEnding, lineEndingOf } from "../../lib/viewers/fileUtils";

describe("lineEndingOf", () => {
  it("reads CRLF when any line ends that way, else LF", () => {
    expect(lineEndingOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineEndingOf("a\nb\n")).toBe("\n");
    // "any CRLF ⇒ CRLF", the rule bib.ts and table.ts already follow: a mixed
    // file is being repaired towards one convention either way, and choosing the
    // Windows one never drops a `\r` somebody else's tooling put there.
    expect(lineEndingOf("a\nb\r\nc\n")).toBe("\r\n");
  });

  it("answers LF for text with no line ending at all, and for empty text", () => {
    expect(lineEndingOf("")).toBe("\n");
    expect(lineEndingOf("one line")).toBe("\n");
  });

  it("is not fooled by a bare CR", () => {
    // A lone `\r` is not a CRLF file; treating it as one would introduce `\r\n`
    // into a file that never had it.
    expect(lineEndingOf("a\rb")).toBe("\n");
  });
});

describe("applyLineEnding", () => {
  it("restores CRLF on a buffer the textarea normalized to LF", () => {
    expect(applyLineEnding("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("normalizes a raw CRLF seed to LF", () => {
    expect(applyLineEnding("a\r\nb\r\nc", "\n")).toBe("a\nb\nc");
  });

  it("is idempotent in both directions — the case that prevents `\\r\\r\\n`", () => {
    // The seed still holds the file's own endings until the first keystroke goes
    // through the DOM, so the save-side call regularly runs over text that is
    // ALREADY CRLF. Matching `\r?\n` rather than `\n` is what keeps that a no-op.
    const crlf = "a\r\nb\r\n";
    expect(applyLineEnding(crlf, "\r\n")).toBe(crlf);
    expect(applyLineEnding(applyLineEnding(crlf, "\r\n"), "\r\n")).toBe(crlf);
    const lf = "a\nb\n";
    expect(applyLineEnding(lf, "\n")).toBe(lf);
    expect(applyLineEnding(applyLineEnding(lf, "\n"), "\n")).toBe(lf);
  });

  it("repairs a mixed buffer to one convention", () => {
    expect(applyLineEnding("a\nb\r\nc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
    expect(applyLineEnding("a\nb\r\nc\n", "\n")).toBe("a\nb\nc\n");
  });

  it("round-trips a CRLF file through the editor's buffer convention", () => {
    // The whole path in one assertion: read from disk, hold as LF, write back.
    const onDisk = "key: value\r\n# a comment\r\nlist:\r\n  - one\r\n";
    const eol = lineEndingOf(onDisk);
    const buffer = applyLineEnding(onDisk, "\n");
    expect(buffer).not.toContain("\r");
    expect(applyLineEnding(buffer, eol)).toBe(onDisk);
  });

  it("leaves an LF file without a single CR after the same round trip", () => {
    const onDisk = "key: value\n# a comment\n";
    expect(applyLineEnding(applyLineEnding(onDisk, "\n"), lineEndingOf(onDisk))).toBe(onDisk);
    expect(applyLineEnding(onDisk, lineEndingOf(onDisk))).not.toContain("\r");
  });

  it("leaves text with no line endings alone", () => {
    expect(applyLineEnding("no endings here", "\r\n")).toBe("no endings here");
    expect(applyLineEnding("", "\r\n")).toBe("");
  });
});
