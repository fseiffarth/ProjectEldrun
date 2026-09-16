/**
 * Edge cases for `lib/viewers/table.ts` beyond `table.test.ts`: malformed
 * quoting, unicode (spans are UTF-16 offsets, and an emoji is two of them),
 * CRLF files carried through a whole edit sequence, BOM-prefixed edits, and
 * the encode → parse round-trip on adversarial values. The invariant under
 * all of it is the module's own: the table is a VIEW on the text, so an edit
 * splices one span and every other byte — quoting, delimiter, line endings —
 * comes back untouched.
 */
import { describe, expect, it } from "vitest";
import {
  columnWidths,
  deleteRow,
  encodeCell,
  filterRefs,
  insertRowAfter,
  parseDelimited,
  parseTable,
  replaceCell,
  sniffDelimiter,
  sortRefs,
} from "../lib/viewers/table";

const BOM = "﻿";

describe("malformed input still yields cells", () => {
  it("an unterminated quote runs to the end of the file rather than throwing", () => {
    expect(parseDelimited('a,"b\nc', ",")).toEqual([["a", "b\nc"]]);
  });

  // Suspected bug: parseTable's docstring promises a mid-field `"` is a literal
  // character, but the parser opens a quoted region on ANY quote, so `b"c,d`
  // swallows the delimiter and reads as one cell `bc,d`.

  // Only a quote that opens a field starts a quoted region.
  it("a quote in the middle of an unquoted field is a literal character", () => {
    expect(parseDelimited('a,b"c,d', ",")).toEqual([["a", 'b"c', "d"]]);
  });

  it("text after a closing quote is appended leniently, as spreadsheet importers do", () => {
    expect(parseDelimited('"a"b,c', ",")).toEqual([["ab", "c"]]);
  });

  it("whitespace-only input is one row with one whitespace cell, not nothing", () => {
    expect(parseDelimited(" ", ",")).toEqual([[" "]]);
  });

  it("bare-CR line endings split rows and their spans step over the CR", () => {
    const t = parseTable("a,b\r1,2\r", ",");
    expect(t.rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(t.rowSpans[0]).toEqual({ start: 0, end: 3, next: 4 });
    expect(t.rowSpans[1]).toEqual({ start: 4, end: 7, next: 8 });
  });
});

describe("unicode", () => {
  const text = "name,note\nZoë,🎉 party\nLi,中文\n";

  it("parses multi-byte and astral characters as ordinary cell content", () => {
    expect(parseDelimited(text, ",")).toEqual([
      ["name", "note"], ["Zoë", "🎉 party"], ["Li", "中文"],
    ]);
  });

  it("splices correctly on either side of an astral character", () => {
    const t = parseTable(text, ",");
    expect(replaceCell(text, t, 1, 0, "Zoé", ",")).toBe("name,note\nZoé,🎉 party\nLi,中文\n");
    expect(replaceCell(text, t, 1, 1, "x", ",")).toBe("name,note\nZoë,x\nLi,中文\n");
    expect(replaceCell(text, t, 2, 1, "日本語", ",")).toBe("name,note\nZoë,🎉 party\nLi,日本語\n");
  });

  it("filters case-insensitively across non-ASCII letters", () => {
    const refs = [{ cells: ["ÉLAN"], index: 1 }, { cells: ["plain"], index: 2 }];
    expect(filterRefs(refs, "élan").map((r) => r.index)).toEqual([1]);
  });
});

describe("a CRLF file through a whole edit sequence", () => {
  const text = "a,b\r\n1,2\r\n3,4\r\n";
  /** True when every LF in `s` is preceded by a CR. */
  const strictlyCrlf = (s: string) => !/(^|[^\r])\n/.test(s);

  it("insert, edit and delete keep every terminator CRLF", () => {
    let t = parseTable(text, ",");
    expect(t.newline).toBe("\r\n");
    let out = insertRowAfter(text, t, 1, 2, ",");
    expect(out).toBe("a,b\r\n1,2\r\n,\r\n3,4\r\n");
    t = parseTable(out, ",");
    out = replaceCell(out, t, 2, 0, "x", ",");
    expect(out).toBe("a,b\r\n1,2\r\nx,\r\n3,4\r\n");
    t = parseTable(out, ",");
    out = deleteRow(out, t, 1);
    expect(out).toBe("a,b\r\nx,\r\n3,4\r\n");
    expect(strictlyCrlf(out)).toBe(true);
    expect(parseTable(out, ",").rows).toEqual([["a", "b"], ["x", ""], ["3", "4"]]);
  });

  it("padding a ragged CRLF row lands the value before the CR", () => {
    const ragged = "a,b,c\r\n1\r\n";
    expect(replaceCell(ragged, parseTable(ragged, ","), 1, 2, "z", ",")).toBe("a,b,c\r\n1,,z\r\n");
  });

  it("deleting an unterminated final CRLF row takes the preceding CRLF, not half of it", () => {
    const unterminated = "a,b\r\n1,2";
    const out = deleteRow(unterminated, parseTable(unterminated, ","), 1);
    expect(out).toBe("a,b");
  });
});

describe("BOM and quoting styles survive an edit", () => {
  it("keeps the BOM in front of an edited first cell", () => {
    const text = `${BOM}a,b\n1,2\n`;
    expect(replaceCell(text, parseTable(text, ","), 0, 0, "x", ",")).toBe(`${BOM}x,b\n1,2\n`);
  });

  it("an empty and a quoted-empty cell are both addressable", () => {
    const bare = "a,,c\n";
    expect(replaceCell(bare, parseTable(bare, ","), 0, 1, "x", ",")).toBe("a,x,c\n");
    const quoted = 'a,"",c\n';
    expect(replaceCell(quoted, parseTable(quoted, ","), 0, 1, "y", ",")).toBe("a,y,c\n");
  });

  it("deleting a row takes an embedded quoted newline with it", () => {
    const text = 'a,b\n"x\ny",2\nc,d\n';
    expect(deleteRow(text, parseTable(text, ","), 1)).toBe("a,b\nc,d\n");
  });

  it("a one-column insert is a blank line the parser reads back as an empty cell", () => {
    const text = "a\nb\n";
    const out = insertRowAfter(text, parseTable(text, ","), 0, 1, ",");
    expect(out).toBe("a\n\nb\n");
    expect(parseDelimited(out, ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("deleting the only row leaves an empty file, terminated or not", () => {
    expect(deleteRow("a,b\n", parseTable("a,b\n", ","), 0)).toBe("");
    expect(deleteRow("a,b", parseTable("a,b", ","), 0)).toBe("");
  });
});

describe("encode → parse round-trip", () => {
  const nasty = [
    " lead", "trail ", 'a"b', "a,b", "a\nb", "a\r\nb", "🎉", ";semi", '"', "a;b|c\td",
  ];

  it("reads back exactly the value it encoded, for every ambiguous shape", () => {
    for (const delimiter of [",", ";", "\t", "|"]) {
      for (const v of nasty) {
        expect(parseDelimited(encodeCell(v, delimiter), delimiter), JSON.stringify([v, delimiter]))
          .toEqual([[v]]);
      }
    }
  });

  it("an edited cell reads back verbatim while its neighbours keep their bytes", () => {
    const text = '"q",b,c\n';
    for (const v of nasty) {
      const out = replaceCell(text, parseTable(text, ","), 0, 1, v, ",");
      expect(out.startsWith('"q",')).toBe(true);
      expect(out.endsWith(",c\n")).toBe(true);
      expect(parseDelimited(out, ",")).toEqual([["q", v, "c"]]);
    }
  });
});

describe("sniffing and sorting on awkward content", () => {
  it("finds a semicolon on a CRLF file", () => {
    expect(sniffDelimiter("a;b\r\n1;2\r\n3;4\r\n")).toBe(";");
  });

  it("is not fooled by every candidate appearing inside quoted fields", () => {
    expect(sniffDelimiter('"a,b;c|d\te",x\n"1,2;3|4\t5",y\n')).toBe(",");
  });

  it("falls back on whitespace-only input", () => {
    expect(sniffDelimiter("  \n\n", "\t")).toBe("\t");
  });

  it("compares numerically through padding, signs and exponents, stably on ties", () => {
    const refs = [{ cells: [" 10"], index: 1 }, { cells: ["-2"], index: 2 }, { cells: ["1e1"], index: 3 }];
    expect(sortRefs(refs, 0, "asc").map((r) => r.cells[0])).toEqual(["-2", " 10", "1e1"]);
  });

  it("measures widths from a sample, so row 1001 cannot resize the table", () => {
    const rows: string[][] = [["h"]];
    for (let i = 0; i < 999; i++) rows.push(["x"]);
    rows.push(["a".repeat(30)]);
    expect(columnWidths(rows, 1)).toEqual([4]);
    rows[500] = ["b".repeat(30)];
    expect(columnWidths(rows, 1)).toEqual([30]);
    expect(columnWidths([], 3)).toEqual([4, 4, 4]);
  });
});
