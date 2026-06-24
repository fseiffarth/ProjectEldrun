/**
 * Unit tests for jump-to-error log parsing: extracting `file:line: message`
 * locations from a TeX build log (compiled with `-file-line-error`) and
 * resolving those paths against the build directory.
 */
import { describe, it, expect } from "vitest";
import { parseTexErrors, resolveTexErrorPath } from "../lib/viewers/tex";

describe("parseTexErrors", () => {
  it("pulls file/line/message out of -file-line-error lines", () => {
    const log = [
      "This is pdfTeX, Version 3.14",
      "(./doc.tex",
      "./doc.tex:12: Undefined control sequence.",
      "l.12 \\badcommand",
      "             {}",
      "./doc.tex:40: Missing $ inserted.",
    ].join("\n");
    expect(parseTexErrors(log)).toEqual([
      { file: "./doc.tex", line: 12, message: "Undefined control sequence." },
      { file: "./doc.tex", line: 40, message: "Missing $ inserted." },
    ]);
  });

  it("captures errors in included child files", () => {
    const log = "./chapters/intro.tex:7: Undefined control sequence.";
    expect(parseTexErrors(log)).toEqual([
      { file: "./chapters/intro.tex", line: 7, message: "Undefined control sequence." },
    ]);
  });

  it("collapses duplicate error lines TeX repeats", () => {
    const log = [
      "./doc.tex:12: Undefined control sequence.",
      "./doc.tex:12: Undefined control sequence.",
    ].join("\n");
    expect(parseTexErrors(log)).toHaveLength(1);
  });

  it("ignores `l.NNN` context dumps and prose without the file:line: form", () => {
    const log = [
      "l.12 \\badcommand",
      "Runaway argument?",
      "LaTeX Warning: Reference `foo' undefined on input line 9.",
    ].join("\n");
    expect(parseTexErrors(log)).toEqual([]);
  });
});

describe("resolveTexErrorPath", () => {
  it("joins a ./-relative path onto the build directory", () => {
    expect(resolveTexErrorPath("/home/u/proj", "./doc.tex")).toBe("/home/u/proj/doc.tex");
    expect(resolveTexErrorPath("/home/u/proj", "chapters/intro.tex")).toBe(
      "/home/u/proj/chapters/intro.tex",
    );
  });

  it("passes an absolute path through unchanged", () => {
    expect(resolveTexErrorPath("/home/u/proj", "/usr/share/texmf/x.sty")).toBe(
      "/usr/share/texmf/x.sty",
    );
  });

  it("strips a trailing slash on the build dir", () => {
    expect(resolveTexErrorPath("/home/u/proj/", "./doc.tex")).toBe("/home/u/proj/doc.tex");
  });
});
