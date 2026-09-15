/**
 * Edge cases for `lib/viewers/bib.ts` beyond `BibViewer.test.ts`: empty and
 * CRLF files, unicode keys and names, case-insensitive types and field names,
 * the record kinds the cards render raw (`@comment`, `@preamble`), values the
 * grammar half-allows (empty, concatenated with quotes, escaped braces,
 * truncated quotes), and the separators `addBibEntry` picks. The invariant is
 * the module's own: every op is a splice, so the bytes it did not aim at —
 * including the file's line endings — come back exactly as they were.
 */
import { describe, expect, it } from "vitest";
import {
  addBibEntry,
  addBibField,
  bibFirstAuthor,
  bibLiteral,
  bibPlainValue,
  deleteBibField,
  deleteBibRecord,
  filterBibRecords,
  parseBib,
  setBibFieldValue,
  setBibType,
} from "../lib/viewers/bib";

/** True when every LF in `s` is preceded by a CR and no CR stands alone. */
const strictlyCrlf = (s: string) => !/(^|[^\r])\n/.test(s) && !/\r(?!\n)/.test(s);

const CRLF = "% c\r\n@article{a,\r\n  author = {A},\r\n  title = {T},\r\n  year = 2020\r\n}\r\n\r\n@book{b,\r\n  title = {B},\r\n}\r\n";

describe("empty and CRLF input", () => {
  it("an empty or whitespace-only file has no records and no stray lines", () => {
    expect(parseBib("")).toEqual({ records: [], strayLines: 0 });
    expect(parseBib("\n\n  \n")).toEqual({ records: [], strayLines: 0 });
  });

  it("parses a CRLF file without a CR leaking into any value", () => {
    const doc = parseBib(CRLF);
    expect(doc.records.map((r) => r.key)).toEqual(["a", "b"]);
    const a = doc.records[0];
    expect(a.fields.map((f) => [f.key, f.value])).toEqual([["author", "A"], ["title", "T"], ["year", "2020"]]);
    expect(a.fields[2].delim).toBe("bare");
    expect(a.line).toBe(2);
    expect(doc.records[1].line).toBe(8);
    expect(doc.strayLines).toBe(1);
  });

  it("setting a value in a CRLF file keeps every terminator", () => {
    const f = parseBib(CRLF).records[0].fields[1];
    const out = setBibFieldValue(CRLF, f, "New");
    expect(out).toBe(CRLF.replace("{T}", "{New}"));
    expect(strictlyCrlf(out)).toBe(true);
  });

  it("deleting a record in a CRLF file takes its blank line and nothing else", () => {
    const out = deleteBibRecord(CRLF, parseBib(CRLF).records[0]);
    expect(out).toBe("% c\r\n@book{b,\r\n  title = {B},\r\n}\r\n");
    expect(strictlyCrlf(out)).toBe(true);
  });

  // Suspected bug: deleteBibField absorbs the LF of the PREVIOUS line's CRLF
  // (its `text[start - 1] === "\n"` check) while keeping the deleted field's
  // own CRLF, so the line before ends up `…},\r\r\n` — a bare CR in the file.

  // The delete takes the field's OWN line ending, never the previous line's LF.
  it("deleting a field in a CRLF file leaves no bare CR behind", () => {
    const out = deleteBibField(CRLF, parseBib(CRLF).records[0].fields[1]);
    expect(out).toBe(CRLF.replace("  title = {T},\r\n", ""));
    expect(strictlyCrlf(out)).toBe(true);
  });

  // Suspected bug: addBibField hardcodes "\n" around the inserted field, so a
  // CRLF file comes back with mixed line endings after one card edit.

  it("adding a field to a CRLF record writes the file's own line ending", () => {
    const out = addBibField(CRLF, parseBib(CRLF).records[1], "year");
    expect(parseBib(out).records[1].fields.map((f) => f.key)).toEqual(["title", "year"]);
    expect(strictlyCrlf(out)).toBe(true);
  });

  // Suspected bug: addBibEntry hardcodes "\n" in its separator and template,
  // so a CRLF file grows LF-terminated lines at its end.

  it("appending an entry to a CRLF file writes the file's own line ending", () => {
    const { text } = addBibEntry(CRLF, parseBib(CRLF));
    expect(parseBib(text).records.map((r) => r.key)).toEqual(["a", "b", "entry"]);
    expect(strictlyCrlf(text)).toBe(true);
  });
});

describe("unicode", () => {
  const text = "@article{müller2020,\n  author = {Müller, Hans and 田中, 太郎},\n  title = {Über 🎉 Emoji},\n}\n";

  it("reads a non-ASCII key, name and title verbatim", () => {
    const rec = parseBib(text).records[0];
    expect(rec.key).toBe("müller2020");
    expect(rec.id).toBe("entry:müller2020");
    expect(bibFirstAuthor(rec)).toBe("Müller");
    expect(rec.fields[1].value).toBe("Über 🎉 Emoji");
  });

  it("splices around an astral character without shifting a byte", () => {
    const rec = parseBib(text).records[0];
    const out = setBibFieldValue(text, rec.fields[0], "田中, 太郎");
    expect(out).toBe(text.replace("{Müller, Hans and 田中, 太郎}", "{田中, 太郎}"));
    expect(parseBib(out).records[0].fields[1].value).toBe("Über 🎉 Emoji");
  });

  it("filters on non-ASCII text in keys and values", () => {
    const records = parseBib(text).records;
    expect(filterBibRecords(records, "MÜLLER")).toHaveLength(1);
    expect(filterBibRecords(records, "über")).toHaveLength(1);
    expect(filterBibRecords(records, "🎉")).toHaveLength(1);
    expect(filterBibRecords(records, "nobody")).toHaveLength(0);
  });
});

describe("case, kinds and half-legal values", () => {
  it("lowercases the type and field key for lookup, keeping the spelling for the splice", () => {
    const text = "@ARTICLE{K,\n  Title = {x},\n}\n";
    const rec = parseBib(text).records[0];
    expect(rec.type).toBe("article");
    expect(rec.typeRaw).toBe("ARTICLE");
    expect(rec.fields[0]).toMatchObject({ name: "Title", key: "title" });
    // A type is sanitized to letters and lowercased; only the type token moves.
    expect(setBibType(text, rec, "In-Proceedings")).toBe("@inproceedings{K,\n  Title = {x},\n}\n");
  });

  it("renders @comment and @preamble raw, with no key and no fields", () => {
    const text = "@Comment{ notes {nested} here }\n@preamble{\"\\newcommand{\\x}{y}\"}\n@misc{k}\n";
    const doc = parseBib(text);
    expect(doc.records.map((r) => r.kind)).toEqual(["comment", "preamble", "entry"]);
    expect(doc.records[0]).toMatchObject({ key: "", fields: [], raw: "@Comment{ notes {nested} here }" });
    expect(doc.records[1].raw).toBe('@preamble{"\\newcommand{\\x}{y}"}');
    expect(doc.records[0].id).toBe("comment:0");
    expect(doc.strayLines).toBe(0);
  });

  it("a quoted concatenation is shown whole but locked", () => {
    const doc = parseBib('@misc{k,\n  title = "a" # " b" # macro,\n}\n');
    const f = doc.records[0].fields[0];
    expect(f).toMatchObject({ value: "a", raw: '"a"', rawExpr: '"a" # " b" # macro', delim: "quote", editable: false });
  });

  it("an empty value does not derail the fields after it", () => {
    const doc = parseBib("@misc{k,\n  title = ,\n  year = 2020,\n}\n");
    const [title, year] = doc.records[0].fields;
    expect(title).toMatchObject({ key: "title", value: "", editable: false });
    expect(year).toMatchObject({ key: "year", value: "2020", editable: true });
  });

  it("a stray token resumes at the next comma rather than swallowing the record", () => {
    const doc = parseBib("@misc{k, junk here, title = {T}}\n");
    expect(doc.records[0].fields.map((f) => f.key)).toEqual(["title"]);
  });

  it("a backslash-escaped brace neither opens nor closes a value", () => {
    const text = "@misc{k,\n  title = {a \\{ b},\n  year = 1,\n}\n";
    const rec = parseBib(text).records[0];
    expect(rec.fields.map((f) => f.value)).toEqual(["a \\{ b", "1"]);
    expect(bibLiteral("a \\{ b", "brace")).toBe("{a \\{ b}");
  });

  it("a truncated quoted value runs to the record's end instead of throwing", () => {
    const doc = parseBib('@misc{a, title = "unterminated');
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0].fields[0]).toMatchObject({ delim: "quote", value: "unterminated" });
  });

  it("bibPlainValue drops every brace and folds whitespace, newlines included", () => {
    expect(bibPlainValue("{The}\n  {ACM}\t way ")).toBe("The ACM way");
    expect(bibPlainValue("")).toBe("");
  });
});

describe("bibLiteral picks the delimiter that can hold the value", () => {
  it("promotes a quoted literal only for a quote or an unbalanced brace", () => {
    expect(bibLiteral("On {LaTeX}", "quote")).toBe('"On {LaTeX}"');
    expect(bibLiteral("a } b", "quote")).toBe("{a \\} b}");
    expect(bibLiteral('say "hi"', "quote")).toBe('{say "hi"}');
  });

  it("keeps a bare literal only while it is a number", () => {
    expect(bibLiteral(" 2021 ", "bare")).toBe("2021");
    expect(bibLiteral("in press", "bare")).toBe("{in press}");
    expect(bibLiteral("", "bare")).toBe("{}");
  });
});

describe("addBibEntry separators", () => {
  const doc = parseBib("");

  it("adds no separator to an empty file, one newline after a terminated one, two otherwise", () => {
    expect(addBibEntry("", doc).text.startsWith("@misc{entry,\n")).toBe(true);
    expect(addBibEntry("x\n", doc).text.startsWith("x\n\n@misc{")).toBe(true);
    expect(addBibEntry("x", doc).text.startsWith("x\n\n@misc{")).toBe(true);
    expect(addBibEntry("x\n\n", doc).text.startsWith("x\n\n@misc{")).toBe(true);
  });

  it("uses the requested type and avoids a taken key case-insensitively", () => {
    const text = "@misc{Entry,}\n";
    const { text: out, key } = addBibEntry(text, parseBib(text), "book");
    expect(key).toBe("entry1");
    expect(out).toContain("@book{entry1,");
  });
});
