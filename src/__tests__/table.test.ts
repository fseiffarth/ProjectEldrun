import { describe, it, expect } from "vitest";
import { parseDelimited, sortRows, delimiterForPath } from "../lib/viewers/table";

describe("parseDelimited — basics", () => {
  it("parses a simple comma-separated grid", () => {
    expect(parseDelimited("a,b,c\n1,2,3", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("parses tab-separated values", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns no rows for empty input", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("preserves empty fields", () => {
    expect(parseDelimited("a,,c", ",")).toEqual([["a", "", "c"]]);
  });
});

describe("parseDelimited — RFC 4180 quoting", () => {
  it("keeps a delimiter embedded inside a quoted field", () => {
    expect(parseDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
  });

  it("keeps a newline embedded inside a quoted field", () => {
    expect(parseDelimited('"line1\nline2",x', ",")).toEqual([["line1\nline2", "x"]]);
  });

  it("keeps a CRLF embedded inside a quoted field", () => {
    expect(parseDelimited('"line1\r\nline2",x', ",")).toEqual([["line1\r\nline2", "x"]]);
  });

  it("treats \"\" as a single literal quote", () => {
    expect(parseDelimited('"she said ""hi""",end', ",")).toEqual([
      ['she said "hi"', "end"],
    ]);
  });

  it("handles a fully-quoted row with quoted empty field", () => {
    expect(parseDelimited('"a","","c"', ",")).toEqual([["a", "", "c"]]);
  });
});

describe("parseDelimited — line endings, BOM, trailing newline", () => {
  it("handles CRLF line endings", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles bare LF line endings", () => {
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseDelimited("﻿a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("ignores a single trailing newline (no trailing empty row)", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a blank row created by a double trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      [""],
    ]);
  });
});

describe("parseDelimited — ragged rows", () => {
  it("preserves rows of differing widths", () => {
    expect(parseDelimited("a,b,c\n1,2\n9,8,7,6", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2"],
      ["9", "8", "7", "6"],
    ]);
  });
});

describe("delimiterForPath", () => {
  it("picks tab for .tsv and comma otherwise", () => {
    expect(delimiterForPath("/x/data.tsv")).toBe("\t");
    expect(delimiterForPath("/x/data.TSV")).toBe("\t");
    expect(delimiterForPath("/x/data.csv")).toBe(",");
    expect(delimiterForPath("/x/data.txt")).toBe(",");
  });
});

describe("sortRows", () => {
  const rows = [
    ["10", "banana"],
    ["2", "apple"],
    ["1", "cherry"],
  ];

  it("sorts numerically when every cell is a finite number (asc)", () => {
    expect(sortRows(rows, 0, "asc").map((r) => r[0])).toEqual(["1", "2", "10"]);
  });

  it("sorts numerically descending", () => {
    expect(sortRows(rows, 0, "desc").map((r) => r[0])).toEqual(["10", "2", "1"]);
  });

  it("falls back to localeCompare for non-numeric columns (asc)", () => {
    expect(sortRows(rows, 1, "asc").map((r) => r[1])).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);
  });

  it("sorts lexically descending", () => {
    expect(sortRows(rows, 1, "desc").map((r) => r[1])).toEqual([
      "cherry",
      "banana",
      "apple",
    ]);
  });

  it("treats a column with a blank cell as non-numeric (lexical)", () => {
    const mixed = [["3"], ["1"], [""]];
    // "" is non-numeric, so the whole column sorts lexically: "" < "1" < "3".
    expect(sortRows(mixed, 0, "asc").map((r) => r[0])).toEqual(["", "1", "3"]);
  });

  it("does not mutate the input array or its rows", () => {
    const input = [["3"], ["1"], ["2"]];
    const snapshot = JSON.stringify(input);
    const out = sortRows(input, 0, "asc");
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
  });

  it("treats missing cells in ragged rows as empty strings", () => {
    const ragged = [["b", "2"], ["a"], ["c", "1"]];
    // Column 1 has a missing cell (non-numeric due to ""), sorts lexically.
    expect(sortRows(ragged, 1, "asc").map((r) => r[1] ?? "")).toEqual(["", "1", "2"]);
  });

  it("is stable for equal keys", () => {
    const dup = [
      ["1", "first"],
      ["1", "second"],
      ["1", "third"],
    ];
    expect(sortRows(dup, 0, "asc").map((r) => r[1])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
