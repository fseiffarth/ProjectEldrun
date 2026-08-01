/**
 * Tests for the BibTeX (`.bib`) card view's pure half (`lib/viewers/bib`):
 *  - the parse is tolerant and reports what it could not take responsibility for
 *    (stray lines, non-rewritable values, `@string`/`@comment` records),
 *  - every edit op is a SPLICE: the bytes it did not aim at come back untouched,
 *    which is what keeps a hand-sorted, brace-protected, `%`-commented
 *    bibliography intact after an edit made in the cards.
 */
import { describe, it, expect } from "vitest";
import {
  addBibEntry,
  addBibField,
  bibByline,
  bibLiteral,
  bibPlainValue,
  bibRecordLabel,
  deleteBibField,
  deleteBibRecord,
  bibFirstAuthor,
  bibVenue,
  bibVenues,
  bibYear,
  duplicateBibKeys,
  filterBibRecords,
  filterBibVenue,
  isBibPath,
  parseBib,
  setBibFieldName,
  setBibFieldValue,
  setBibKey,
  setBibType,
  sortBibRecords,
} from "../lib/viewers/bib";

const SAMPLE = `% my library, hand-sorted
@string{jml = {J. Machine Learning}}

@article{smith2020,
  author  = {Smith, Jane and Doe, John},
  title   = {On {LaTeX} Autocomplete},
  journal = jml,
  year    = 2020,
}

@book{knuth1984,
  author = "Knuth, Donald",
  title  = "The TeXbook",
  year   = {1984},
}
`;

/** The one field of one record, by citation key and field name. */
function field(text: string, key: string, name: string) {
  const rec = parseBib(text).records.find((r) => r.key === key);
  if (!rec) throw new Error(`no record ${key}`);
  const f = rec.fields.find((x) => x.key === name);
  if (!f) throw new Error(`no field ${name} on ${key}`);
  return f;
}

function record(text: string, key: string) {
  const rec = parseBib(text).records.find((r) => r.key === key);
  if (!rec) throw new Error(`no record ${key}`);
  return rec;
}

describe("isBibPath", () => {
  it("claims .bib and .bibtex, nothing else", () => {
    expect(isBibPath("/p/refs.bib")).toBe(true);
    expect(isBibPath("C:\\p\\Refs.BIB")).toBe(true);
    expect(isBibPath("/p/refs.bibtex")).toBe(true);
    expect(isBibPath("/p/paper.tex")).toBe(false);
    expect(isBibPath("/p/bib")).toBe(false);
  });
});

describe("parseBib", () => {
  it("reads every record, its type, key and fields", () => {
    const doc = parseBib(SAMPLE);
    expect(doc.records.map((r) => [r.kind, r.type, r.key])).toEqual([
      ["string", "string", ""],
      ["entry", "article", "smith2020"],
      ["entry", "book", "knuth1984"],
    ]);
    const smith = record(SAMPLE, "smith2020");
    expect(smith.fields.map((f) => f.key)).toEqual(["author", "title", "journal", "year"]);
    expect(smith.line).toBe(4);
  });

  it("keeps a value's inner text VERBATIM, braces and all", () => {
    // The brace protection is content — it is what stops BibTeX lowercasing
    // "LaTeX" — so the edit form must round-trip it.
    expect(field(SAMPLE, "smith2020", "title").value).toBe("On {LaTeX} Autocomplete");
    // …while the display/search form is the cleaned one.
    expect(bibPlainValue(field(SAMPLE, "smith2020", "title").value)).toBe(
      "On LaTeX Autocomplete",
    );
  });

  it("records each value's delimiter, so an edit can keep the file's style", () => {
    expect(field(SAMPLE, "smith2020", "title").delim).toBe("brace");
    expect(field(SAMPLE, "knuth1984", "title").delim).toBe("quote");
    expect(field(SAMPLE, "smith2020", "year").delim).toBe("bare");
  });

  it("refuses to offer a macro reference or a # concatenation for editing", () => {
    // `journal = jml` names a @string macro: rewriting it as `{jml}` would change
    // what the bibliography renders.
    const journal = field(SAMPLE, "smith2020", "journal");
    expect(journal.editable).toBe(false);
    expect(journal.rawExpr).toBe("jml");
    // A plain number is the one bare value that IS safe to rewrite.
    expect(field(SAMPLE, "smith2020", "year").editable).toBe(true);

    const concat = `@article{a, month = jan # "~1", title = "x" # "y",}`;
    const rec = record(concat, "a");
    expect(rec.fields.map((f) => [f.key, f.editable])).toEqual([
      ["month", false],
      ["title", false],
    ]);
    // The whole expression is kept for display: a value the cards won't edit is
    // still shown in full.
    expect(rec.fields[0].rawExpr).toBe('jan # "~1"');
  });

  it("counts text outside every record rather than dropping it silently", () => {
    expect(parseBib(SAMPLE).strayLines).toBe(1); // the leading `%` comment
    expect(parseBib("@misc{a,}\n\n\n").strayLines).toBe(0);
  });

  it("is not fooled by an @ inside a field value", () => {
    const doc = parseBib(`@misc{a, note = {mail me @ home, @article{fake}}}`);
    expect(doc.records.map((r) => r.key)).toEqual(["a"]);
    expect(doc.records[0].fields[0].value).toBe("mail me @ home, @article{fake}");
  });

  it("survives a truncated record instead of throwing", () => {
    const doc = parseBib("@article{cut,\n  title = {Half a rec");
    expect(doc.records).toHaveLength(1);
    expect(doc.records[0].key).toBe("cut");
  });

  it("treats a @type(…) record as opaque (no key, no fields) rather than guessing", () => {
    const doc = parseBib("@article(paren, title = {x})");
    expect(doc.records[0].kind).toBe("entry");
    expect(doc.records[0].keyEnd).toBe(0);
    expect(doc.records[0].fields).toEqual([]);
  });
});

describe("duplicate keys / filter / labels", () => {
  it("reports a citation key used twice, case-insensitively", () => {
    const doc = parseBib("@misc{Dup,}\n@article{dup,}\n@book{other,}");
    expect([...duplicateBibKeys(doc)]).toEqual(["dup"]);
  });

  it("still gives every record a unique id when two share a key", () => {
    // The ids are React keys and fold keys; two cards sharing one is a rendering
    // bug on top of the bibliography bug the badge already reports.
    const doc = parseBib("@misc{same,}\n@article{same,}\n@book{same,}");
    expect(new Set(doc.records.map((r) => r.id)).size).toBe(3);
    // The FIRST holder keeps the plain, position-independent id, so the common case
    // (no duplicates) has folds that survive entries being added above them.
    expect(doc.records[0].id).toBe("entry:same");
  });

  it("filters on the key, the type and every field value", () => {
    const { records } = parseBib(SAMPLE);
    expect(filterBibRecords(records, "knuth").map((r) => r.key)).toEqual(["knuth1984"]);
    expect(filterBibRecords(records, "book").map((r) => r.key)).toEqual(["knuth1984"]);
    // Brace protection must not hide a title from its own search term.
    expect(filterBibRecords(records, "latex autocomplete").map((r) => r.key)).toEqual([
      "smith2020",
    ]);
    expect(filterBibRecords(records, "  ").map((r) => r.key)).toEqual(records.map((r) => r.key));
  });

  it("labels a record by its title, falling back to the key", () => {
    expect(bibRecordLabel(record(SAMPLE, "knuth1984"))).toBe("The TeXbook");
    expect(bibRecordLabel(record("@misc{lonely,}", "lonely"))).toBe("lonely");
    expect(bibByline(record(SAMPLE, "smith2020"))).toBe("Smith, Jane and Doe, John · 2020");
    expect(bibByline(record("@misc{none,}", "none"))).toBe("");
  });
});

describe("edit ops splice, they never re-serialize", () => {
  it("sets a value and leaves every other byte alone", () => {
    const next = setBibFieldValue(SAMPLE, field(SAMPLE, "smith2020", "title"), "A New Title");
    expect(next).toBe(SAMPLE.replace("{On {LaTeX} Autocomplete}", "{A New Title}"));
    // The `%` comment, the @string record, the aligned `=` columns and the other
    // entry are all still there, byte for byte.
    expect(next.startsWith("% my library, hand-sorted\n")).toBe(true);
    expect(next).toContain('author = "Knuth, Donald"');
  });

  it("keeps a quoted value quoted, and promotes it only when it must", () => {
    const quoted = field(SAMPLE, "knuth1984", "title");
    expect(setBibFieldValue(SAMPLE, quoted, "The TeXbook, 2nd ed.")).toContain(
      '"The TeXbook, 2nd ed."',
    );
    // A value carrying a `"` cannot stay in a quoted literal.
    expect(setBibFieldValue(SAMPLE, quoted, 'He said "hi"')).toContain('{He said "hi"}');
    // A bare number stays bare while it is still a number.
    const year = field(SAMPLE, "smith2020", "year");
    expect(setBibFieldValue(SAMPLE, year, "2021")).toContain("year    = 2021,");
    expect(setBibFieldValue(SAMPLE, year, "in press")).toContain("year    = {in press},");
  });

  it("escapes an unbalanced brace instead of writing a value that breaks the file", () => {
    expect(bibLiteral("a { b", "brace")).toBe("{a \\{ b}");
    // A balanced one is content and is written through untouched.
    expect(bibLiteral("On {LaTeX}", "brace")).toBe("{On {LaTeX}}");
    const next = setBibFieldValue(SAMPLE, field(SAMPLE, "knuth1984", "title"), "a } b");
    // Whatever it wrote, the file must still parse to the same three records.
    expect(parseBib(next).records.map((r) => r.key)).toEqual(["", "smith2020", "knuth1984"]);
  });

  it("renames a field and an entry key, sanitizing what BibTeX can't hold", () => {
    expect(setBibFieldName(SAMPLE, field(SAMPLE, "smith2020", "journal"), "booktitle")).toContain(
      "booktitle = jml",
    );
    expect(setBibKey(SAMPLE, record(SAMPLE, "smith2020"), "smith2020a")).toContain(
      "@article{smith2020a,",
    );
    // A key with a comma/brace in it would not parse back, so it is stripped…
    expect(setBibKey(SAMPLE, record(SAMPLE, "smith2020"), "a,b{c}")).toContain("@article{abc,");
    // …and one that sanitizes to nothing leaves the text untouched.
    expect(setBibKey(SAMPLE, record(SAMPLE, "smith2020"), "  ")).toBe(SAMPLE);
    expect(setBibType(SAMPLE, record(SAMPLE, "smith2020"), "inproceedings")).toContain(
      "@inproceedings{smith2020,",
    );
  });

  it("deletes a field without leaving a ragged line behind", () => {
    const next = deleteBibField(SAMPLE, field(SAMPLE, "smith2020", "journal"));
    expect(next).not.toContain("journal");
    expect(parseBib(next).records.find((r) => r.key === "smith2020")!.fields.map((f) => f.key))
      .toEqual(["author", "title", "year"]);
    // No blank line where the field was.
    expect(next).toContain("title   = {On {LaTeX} Autocomplete},\n  year    = 2020,");
  });

  it("deletes a record and the blank line it separated", () => {
    const next = deleteBibRecord(SAMPLE, record(SAMPLE, "smith2020"));
    expect(parseBib(next).records.map((r) => r.key)).toEqual(["", "knuth1984"]);
    expect(next).not.toContain("Autocomplete");
    expect(next).toContain("% my library, hand-sorted");
    expect(next).not.toMatch(/\n\n\n/);
  });

  it("adds a field in the record's own indentation, before its closing brace", () => {
    const next = addBibField(SAMPLE, record(SAMPLE, "knuth1984"), "publisher");
    expect(next).toContain('year   = {1984},\n  publisher = {},\n}');
    expect(parseBib(next).records.find((r) => r.key === "knuth1984")!.fields.map((f) => f.key))
      .toEqual(["author", "title", "year", "publisher"]);
  });

  it("adds a field to a record that has none, and to one with no trailing comma", () => {
    const bare = "@misc{lonely}\n";
    const one = addBibField(bare, record(bare, "lonely"), "title");
    expect(parseBib(one).records[0].fields.map((f) => f.key)).toEqual(["title"]);

    const noComma = "@misc{x,\n  title = {T}\n}\n";
    const two = addBibField(noComma, record(noComma, "x"), "year");
    expect(parseBib(two).records[0].fields.map((f) => f.key)).toEqual(["title", "year"]);
  });

  it("mints a new entry's key by scanning for a free one, never by counting", () => {
    const first = addBibEntry(SAMPLE, parseBib(SAMPLE));
    expect(first.key).toBe("entry");
    const second = addBibEntry(first.text, parseBib(first.text));
    expect(second.key).toBe("entry1");
    // …and the mint is never handed a key a *deleted* record used to hold: what it
    // avoids is what the file holds NOW.
    const doc = parseBib(second.text);
    expect(duplicateBibKeys(doc).size).toBe(0);
    expect(doc.records.map((r) => r.key)).toContain("entry1");
    // The file it appended to is otherwise unchanged.
    expect(second.text.startsWith(SAMPLE)).toBe(true);
  });
});

/**
 * Reading the list — the venue picker and the sort control. Everything here is
 * display-only by construction: the ops above splice the file, these only choose
 * which records the view shows and in what order, so a `.bib` somebody sorted by
 * hand is never rewritten by being looked at differently.
 */
describe("bib list: venue + order", () => {
  const LIB = `@inproceedings{a2020,
  author = {Zeta, Ana},
  title = {A},
  booktitle = {Proc. NeurIPS},
  year = {2020},
}
@inproceedings{b2018,
  author = {Brown, Bob and Zeta, Ana},
  title = {B},
  booktitle = {proc. neurips},
  year = {2018},
}
@article{c2024,
  author = {Jane Miller},
  title = {C},
  journal = {J. Machine Learning},
  date = {2024-05-01},
}
@book{d,
  title = {D},
}
`;
  const records = parseBib(LIB).records;

  it("reads the first author's family name from both name forms", () => {
    expect(bibFirstAuthor(records[0])).toBe("Zeta");
    // `and` separates authors: the FIRST one is the sort key, never the list.
    expect(bibFirstAuthor(records[1])).toBe("Brown");
    // "Jane Miller" — no comma, so the last token is the family name.
    expect(bibFirstAuthor(records[2])).toBe("Miller");
    expect(bibFirstAuthor(records[3])).toBe("");
  });

  it("reads a year from `year` and from a BibLaTeX `date`", () => {
    expect(bibYear(records[0])).toBe(2020);
    expect(bibYear(records[2])).toBe(2024);
    expect(bibYear(records[3])).toBeNull();
  });

  it("takes the venue from booktitle or journal, and lists each one once", () => {
    expect(bibVenue(records[0])).toBe("Proc. NeurIPS");
    expect(bibVenue(records[2])).toBe("J. Machine Learning");
    expect(bibVenue(records[3])).toBe("");
    // Deduped case-insensitively, keeping the file's own spelling.
    expect(bibVenues(records)).toEqual(["J. Machine Learning", "Proc. NeurIPS"]);
  });

  it("filters to one venue, case-insensitively and exactly", () => {
    expect(filterBibVenue(records, "proc. neurips").map((r) => r.key)).toEqual([
      "a2020",
      "b2018",
    ]);
    // Exact, not substring: a venue picked from the list means that venue.
    expect(filterBibVenue(records, "neurips")).toHaveLength(0);
    expect(filterBibVenue(records, "")).toHaveLength(records.length);
  });

  it("sorts by first author and by year, keeping unkeyable records last both ways", () => {
    expect(sortBibRecords(records, "author").map((r) => r.key)).toEqual([
      "b2018", "c2024", "a2020", "d",
    ]);
    expect(sortBibRecords(records, "author", true).map((r) => r.key)).toEqual([
      "a2020", "c2024", "b2018", "d",
    ]);
    expect(sortBibRecords(records, "year").map((r) => r.key)).toEqual([
      "b2018", "a2020", "c2024", "d",
    ]);
    expect(sortBibRecords(records, "year", true).map((r) => r.key)).toEqual([
      "c2024", "a2020", "b2018", "d",
    ]);
  });

  it("keeps the file's own order, and never mutates the parse's array", () => {
    const before = records.map((r) => r.key);
    expect(sortBibRecords(records, "file")).toBe(records);
    expect(sortBibRecords(records, "file", true).map((r) => r.key)).toEqual(
      [...before].reverse(),
    );
    sortBibRecords(records, "year");
    // The edit ops address the file by the offsets in THIS array — sorting a view
    // of it must not reorder it underneath them.
    expect(records.map((r) => r.key)).toEqual(before);
  });

  it("breaks a tie with the file's order, in both directions", () => {
    const same = parseBib(
      "@misc{x, author = {Ash, A}, year = {2020},}\n@misc{y, author = {Ash, A}, year = {2020},}\n",
    ).records;
    expect(sortBibRecords(same, "author").map((r) => r.key)).toEqual(["x", "y"]);
    expect(sortBibRecords(same, "author", true).map((r) => r.key)).toEqual(["x", "y"]);
  });

  it("composes with the text filter without either seeing the other", () => {
    const shown = sortBibRecords(
      filterBibVenue(filterBibRecords(records, "zeta"), "Proc. NeurIPS"),
      "year",
    );
    // "zeta" matches both NeurIPS papers (she is second author on one of them).
    expect(shown.map((r) => r.key)).toEqual(["b2018", "a2020"]);
  });
});
