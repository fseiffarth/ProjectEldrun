/**
 * Unit tests for jump-to-error log parsing: extracting `file:line: message`
 * locations from a TeX build log (compiled with `-file-line-error`) and
 * resolving those paths against the build directory.
 */
import { describe, it, expect } from "vitest";
import {
  compileWasNoop,
  parseTexErrors,
  resolveTexErrorPath,
  texDiagnosticsByFile,
} from "../lib/viewers/tex";

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

  it("resolves against a native Windows build dir, joining with backslashes", () => {
    expect(resolveTexErrorPath("C:\\Users\\u\\proj", ".\\doc.tex")).toBe(
      "C:\\Users\\u\\proj\\doc.tex",
    );
    expect(resolveTexErrorPath("C:\\Users\\u\\proj", "chapters/intro.tex")).toBe(
      "C:\\Users\\u\\proj\\chapters\\intro.tex",
    );
  });

  it("passes a Windows absolute path through unchanged", () => {
    expect(resolveTexErrorPath("C:\\Users\\u\\proj", "C:\\texmf\\x.sty")).toBe(
      "C:\\texmf\\x.sty",
    );
  });
});

describe("compileWasNoop", () => {
  it("recognises the latexmk run that executed no engine, and not a real build", () => {
    const noop = [
      "Rc files read:",
      "  .latexmkrc",
      "Latexmk: This is Latexmk, John Collins, 15 June 2025. Version 4.87.",
      "Latexmk: Nothing to do for 'main.tex'.",
      "Latexmk: All targets (main.pdf) are up-to-date",
      "",
    ].join("\n");
    expect(compileWasNoop(noop)).toBe(true);
    // A real build also ends on the up-to-date line, so that alone must not count.
    const built = [
      "Latexmk: applying rule 'lualatex'...",
      "Output written on main.pdf (58 pages, 2548134 bytes).",
      "Latexmk: All targets (main.pdf) are up-to-date",
      "",
    ].join("\n");
    expect(compileWasNoop(built)).toBe(false);
    expect(compileWasNoop("")).toBe(false);
  });
});

describe("texDiagnosticsByFile", () => {
  const dir = "/doc";
  const root = "/doc/main.tex";

  it("buckets errors and warnings by resolved absolute path", () => {
    const byFile = texDiagnosticsByFile(
      dir,
      root,
      [
        { file: "./chapters/intro.tex", line: 12, message: "Undefined control sequence." },
        { file: "./chapters/intro.tex", line: 40, message: "Missing $ inserted." },
        { file: "/doc/main.tex", line: 3, message: "Emergency stop." },
      ],
      [{ kind: "reference", message: "Reference `fig:x' undefined", file: "chapters/intro.tex", line: 22 }],
    );
    expect(byFile.get("/doc/chapters/intro.tex")).toEqual({
      errors: 2,
      warnings: 1,
      // The FIRST error's line, not the last: a LaTeX build's later errors are
      // usually the first one's wreckage.
      errorLine: 12,
      warningLine: 22,
    });
    expect(byFile.get("/doc/main.tex")).toEqual({ errors: 1, warnings: 0, errorLine: 3 });
  });

  it("attributes a warning with no file to the built root, like the warnings card", () => {
    const byFile = texDiagnosticsByFile(dir, root, [], [
      { kind: "other", message: "Font shape undefined", line: 9 },
    ]);
    expect(byFile.get("/doc/main.tex")).toEqual({ errors: 0, warnings: 1, warningLine: 9 });
  });

  it("leaves a warning that carries no line without a jump target", () => {
    const byFile = texDiagnosticsByFile(dir, root, [], [
      { kind: "other", message: "Rerun to get cross-references right", file: "main.tex" },
      { kind: "other", message: "Later one, with a line", file: "main.tex", line: 7 },
    ]);
    expect(byFile.get("/doc/main.tex")).toEqual({ errors: 0, warnings: 2, warningLine: 7 });
  });

  it("is empty for a clean build, which is what clears the badges", () => {
    expect(texDiagnosticsByFile(dir, root, [], []).size).toBe(0);
  });
});
