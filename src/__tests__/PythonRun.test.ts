import { describe, it, expect } from "vitest";
import {
  buildDebugCommand,
  buildRunCommand,
  pyTabLabel,
  runCwd,
  shellQuote,
  systemInterpreter,
} from "../lib/pythonRun";

describe("shellQuote", () => {
  it("single-quotes on unix and escapes an embedded quote", () => {
    expect(shellQuote("/a/b c.py", "unix")).toBe("'/a/b c.py'");
    expect(shellQuote("it's.py", "unix")).toBe(`'it'\\''s.py'`);
  });

  it("double-quotes on windows (cmd.exe has no single-quote syntax)", () => {
    expect(shellQuote("C:\\a b\\x.py", "windows")).toBe('"C:\\a b\\x.py"');
    expect(shellQuote('a"b', "windows")).toBe('"a""b"');
  });
});

describe("systemInterpreter", () => {
  // Interpreter *selection* (venv/poetry/conda/pyenv precedence) lives in the
  // backend (`commands::python`) and is tested there — one ranking, one place.
  // What the frontend still owns is the last-resort fallback when the backend
  // can't be reached at all, so Run degrades instead of refusing.
  it("is the platform's system python", () => {
    expect(systemInterpreter("unix")).toBe("python3");
    expect(systemInterpreter("windows")).toBe("python");
  });
});

describe("buildRunCommand", () => {
  it("quotes both the interpreter and the file", () => {
    expect(buildRunCommand(".venv/bin/python", "/proj/a b/main.py", "unix")).toBe(
      "'.venv/bin/python' '/proj/a b/main.py'",
    );
  });
});

describe("buildDebugCommand", () => {
  const FILE = "/proj/main.py";

  it("pre-loads the breakpoints and runs straight to the first one", () => {
    expect(buildDebugCommand("python3", FILE, [12, 4], "unix")).toBe(
      "'python3' -m pdb -c 'b /proj/main.py:4' -c 'b /proj/main.py:12' -c 'continue' '/proj/main.py'",
    );
  });

  it("omits `continue` with no breakpoints, so pdb stops at the first line", () => {
    // With a trailing `continue` and nothing to break on, pdb would run the
    // program to completion — "debug" would be indistinguishable from "run".
    expect(buildDebugCommand("python3", FILE, [], "unix")).toBe(
      "'python3' -m pdb '/proj/main.py'",
    );
  });

  it("sorts and deduplicates the breakpoint lines", () => {
    const cmd = buildDebugCommand("python3", FILE, [9, 3, 9], "unix");
    expect(cmd.match(/-c 'b [^']+'/g)).toEqual([
      "-c 'b /proj/main.py:3'",
      "-c 'b /proj/main.py:9'",
    ]);
  });

  it("quotes a windows path (whose drive colon must survive pdb's file:line split)", () => {
    expect(buildDebugCommand("python", "C:\\p\\main.py", [7], "windows")).toBe(
      '"python" -m pdb -c "b C:\\p\\main.py:7" -c "continue" "C:\\p\\main.py"',
    );
  });
});

describe("pyTabLabel", () => {
  it("names the tab after the file, marked by mode", () => {
    expect(pyTabLabel("run", "/proj/pkg/main.py")).toBe("▶ main.py");
    expect(pyTabLabel("debug", "/proj/pkg/main.py")).toBe("🐞 main.py");
  });
});

describe("runCwd", () => {
  it("runs from the project root when there is one", () => {
    expect(runCwd("/proj", "/proj/pkg/main.py")).toBe("/proj");
  });
  it("falls back to the file's own directory outside a project", () => {
    expect(runCwd(null, "/tmp/scratch/main.py")).toBe("/tmp/scratch");
    expect(runCwd("", "/tmp/scratch/main.py")).toBe("/tmp/scratch");
  });
});
