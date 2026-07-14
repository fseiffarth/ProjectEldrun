/**
 * Python editor intelligence for the native code viewer (#py).
 *
 * Two independent features live here, both **pure** — every filesystem touch is
 * injected — so the whole surface is unit-testable without a webview or a host:
 *
 *  1. **Breakpoints.** The gutter's red dots. A breakpoint is a line number, and
 *     the only two hard parts are that pdb refuses blank/comment lines (so a
 *     click has to *snap* to the next executable one) and that a breakpoint must
 *     survive an edit above it (so it has to be *remapped* as the draft changes).
 *  2. **Go-to-definition.** Ctrl/Cmd+Click a name and land on its `def`/`class` —
 *     in this file or in the module it was imported from.
 *
 * The resolver is deliberately a *lexical* one, not a type inferencer: it follows
 * the import graph and matches `def`/`class`/assignment names. That covers the
 * overwhelmingly common cases (`from .util import helper` → `util.py`'s
 * `def helper`) and, crucially, it is honest about what it can't do — an
 * unresolvable name simply doesn't underline, so the affordance never lies.
 * Anything requiring real type inference (`obj.method()` where `obj` is a local)
 * is out of scope by construction.
 */

import { dirname, resolvePath } from "../paths";

const PY_EXTENSIONS = [".py", ".pyi", ".pyw"];

export function isPythonPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Breakpoints ──────────────────────────────────────────────────────────────

/**
 * Can pdb break on this line's text? Blank lines and pure comments carry no
 * bytecode, and `break` on one is an error ("Blank or comment"), so the gutter
 * must never place a breakpoint there. Decorators are excluded too: `@foo` is
 * executed at *definition* time, and a break there fires on import rather than
 * on the call the user meant.
 */
export function isExecutableLine(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (t.startsWith("#")) return false;
  if (t.startsWith("@")) return false;
  return true;
}

/**
 * The line a click on `line` (1-based) should actually breakpoint on: `line`
 * itself when it is executable, else the next executable line below it. Returns
 * null when nothing below is executable (a click in the trailing blank space
 * after the last statement), so the caller can no-op rather than set a
 * breakpoint pdb will reject.
 */
export function snapBreakpointLine(source: string, line: number): number | null {
  const lines = source.split("\n");
  for (let i = line - 1; i < lines.length; i++) {
    if (isExecutableLine(lines[i])) return i + 1;
  }
  return null;
}

/**
 * Carry breakpoints across an edit.
 *
 * A breakpoint is bound to a *line number*, so inserting or deleting lines above
 * one silently re-points it at the wrong statement — the dot stays put on screen
 * while the code under it slides. We recompute instead: find the span of lines the
 * edit actually touched (the unchanged common prefix/suffix of the two drafts) and
 * shift every breakpoint below it by the line-count delta. Breakpoints *inside* the
 * edited span are dropped — their statement may not exist any more, and guessing
 * where it went would be worse than losing the dot the user can see is gone.
 */
export function remapBreakpoints(prev: string, next: string, bps: number[]): number[] {
  if (prev === next || bps.length === 0) return bps;

  const a = prev.split("\n");
  const b = next.split("\n");

  // Common prefix of unchanged lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  // Common suffix of unchanged lines, not overlapping the prefix.
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  // Lines [head+1 … a.length-tail] (1-based) of `prev` were replaced.
  const editedFrom = head + 1;
  const editedTo = a.length - tail;
  const delta = b.length - a.length;

  const out: number[] = [];
  for (const bp of bps) {
    if (bp < editedFrom) out.push(bp); // above the edit: untouched
    else if (bp > editedTo) out.push(bp + delta); // below it: slides by the delta
    // inside the edited span: dropped
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

// ── Lexing ───────────────────────────────────────────────────────────────────

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
/** String prefixes (`r"…"`, `f"…"`, `rb"…"`, …). An identifier immediately
 *  followed by a quote is a prefix, not a name. */
const STRING_PREFIX = new Set(["r", "b", "u", "f", "rb", "br", "fr", "rf"]);

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/** One identifier occurrence in code (never inside a string or comment). */
export interface PyToken {
  name: string;
  start: number;
  end: number;
  /** The identifier immediately before a `.` preceding this one (`os.path` →
   *  `path`'s qualifier is `os`), or null when this name stands alone. */
  qualifier: string | null;
}

/**
 * Every identifier in `source` that is really *code* — string bodies, comments
 * and string prefixes are skipped. This is the substrate for both the link
 * ranges and the ref-at-caret lookup: a lexer, not a parser, which is all the
 * lexical resolver needs and is robust against the syntax errors a live editor
 * buffer is full of.
 */
export function pythonTokens(source: string): PyToken[] {
  const out: PyToken[] = [];
  const n = source.length;
  let i = 0;
  // The last identifier seen, and whether a bare `.` sat between it and here —
  // together they give each token its qualifier.
  let prevIdent: string | null = null;
  let prevIdentEnd = -1;

  while (i < n) {
    const c = source[i];

    if (c === "#") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    if (c === '"' || c === "'") {
      i = skipString(source, i);
      prevIdent = null;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(source);
      // The regex is sticky and `c` starts an identifier, so this always matches.
      const name = m![0];
      const start = i;
      const end = i + name.length;

      // A string prefix (`f"…"`) is part of the literal, not a name.
      const next = source[end];
      if ((next === '"' || next === "'") && STRING_PREFIX.has(name.toLowerCase())) {
        i = skipString(source, end);
        prevIdent = null;
        continue;
      }

      // Qualified? Only when a single `.` separates us from the previous
      // identifier (whitespace around it is legal Python).
      let qualifier: string | null = null;
      if (prevIdent != null) {
        const between = source.slice(prevIdentEnd, start);
        if (/^\s*\.\s*$/.test(between)) qualifier = prevIdent;
      }

      out.push({ name, start, end, qualifier });
      prevIdent = name;
      prevIdentEnd = end;
      i = end;
      continue;
    }

    // Anything that isn't whitespace or a dot breaks a dotted chain.
    if (!/[\s.]/.test(c)) {
      prevIdent = null;
    }
    i++;
  }

  return out;
}

/** Index just past the string literal starting at `i` (which is on its quote).
 *  Handles triple quotes and backslash escapes; an unterminated literal (the
 *  normal state of a buffer being typed into) consumes to EOF. */
function skipString(source: string, i: number): number {
  const q = source[i];
  const triple = source.startsWith(q.repeat(3), i);
  const close = triple ? q.repeat(3) : q;
  let j = i + close.length;
  while (j < source.length) {
    if (source[j] === "\\") {
      j += 2;
      continue;
    }
    if (source.startsWith(close, j)) return j + close.length;
    // A single-quoted literal cannot span a newline.
    if (!triple && source[j] === "\n") return j;
    j++;
  }
  return source.length;
}

// ── Definitions ──────────────────────────────────────────────────────────────

export interface PyDef {
  name: string;
  /** 1-based line of the definition. */
  line: number;
  /** 0-based column of the *name* (so the caret lands on it, not on `def`). */
  column: number;
  kind: "def" | "class" | "var";
}

const DEF_RE = /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;
/** A module-level (unindented) binding: `NAME = …` or `NAME: T = …`. Catches the
 *  constants and singletons a `from x import CONFIG` points at. */
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[^=\n]+)?=(?!=)/;

/** Every `def`/`class`/module-level assignment in `source`, in file order. */
export function findPythonDefs(source: string): PyDef[] {
  const out: PyDef[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const d = DEF_RE.exec(text);
    if (d) {
      out.push({
        name: d[2],
        line: i + 1,
        column: text.indexOf(d[2], d[0].length - d[2].length),
        kind: d[1] === "class" ? "class" : "def",
      });
      continue;
    }
    const a = ASSIGN_RE.exec(text);
    if (a) out.push({ name: a[1], line: i + 1, column: 0, kind: "var" });
  }
  return out;
}

/** The definition of `name` in `source`, preferring a `def`/`class` over a bare
 *  assignment (a function shadowed by a later `f = None` should still jump to
 *  the function). */
export function findDef(source: string, name: string): PyDef | null {
  const defs = findPythonDefs(source).filter((d) => d.name === name);
  if (defs.length === 0) return null;
  return defs.find((d) => d.kind !== "var") ?? defs[0];
}

// ── Imports ──────────────────────────────────────────────────────────────────

/**
 * One name this file binds via an import.
 *
 * The two Python import forms collapse into one record. `import os.path as p`
 * binds the *module* `os.path` to `p` (`symbol` empty). `from .util import helper`
 * binds the *symbol* `helper` out of the relative module `util` (`level` 1).
 */
export interface PyImport {
  /** The name as it is used in this file (the `as` alias when there is one). */
  local: string;
  /** Dotted module path; "" for a bare relative import (`from . import x`). */
  module: string;
  /** Leading-dot count: 0 = absolute, 1 = this package, 2 = parent, … */
  level: number;
  /** The symbol taken out of `module`, or "" when `local` *is* the module. */
  symbol: string;
}

/**
 * Parse the import statements of `source`.
 *
 * Comments and strings are stripped first (via {@link pythonTokens}' sibling
 * logic) — a docstring containing the word "import" must not bind a name. Only
 * statement-leading `import`/`from` are considered, and parenthesised multi-line
 * `from x import (a, b)` lists are joined before splitting.
 */
export function parsePythonImports(source: string): PyImport[] {
  const out: PyImport[] = [];
  for (const stmt of importStatements(source)) {
    const from = /^from[ \t]+(\.*)([A-Za-z_][A-Za-z0-9_.]*)?[ \t]+import[ \t]+(.+)$/s.exec(stmt);
    if (from) {
      const level = from[1].length;
      const module = from[2] ?? "";
      const body = from[3].replace(/^\(|\)$/g, "").trim();
      for (const part of body.split(",")) {
        const item = /^([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+as[ \t]+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(
          part.trim(),
        );
        if (!item) continue; // `*`, or a fragment mid-typing
        out.push({ local: item[2] ?? item[1], module, level, symbol: item[1] });
      }
      continue;
    }

    const plain = /^import[ \t]+(.+)$/s.exec(stmt);
    if (plain) {
      for (const part of plain[1].split(",")) {
        const item = /^([A-Za-z_][A-Za-z0-9_.]*)(?:[ \t]+as[ \t]+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(
          part.trim(),
        );
        if (!item) continue;
        const module = item[1];
        // `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
        const local = item[2] ?? module.split(".")[0];
        out.push({ local, module, level: 0, symbol: "" });
      }
    }
  }
  return out;
}

/** The logical import statements of `source`: comment/string-free, with
 *  parenthesised and backslash continuations folded into one line each. */
function importStatements(source: string): string[] {
  const out: string[] = [];
  const lines = stripCommentsAndStrings(source).split("\n");
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    if (!/^[ \t]*(?:import|from)[ \t]/.test(text)) continue;
    // Fold continuations: an open paren, or a trailing backslash.
    let depth = (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0);
    while ((depth > 0 || /\\$/.test(text)) && i + 1 < lines.length) {
      text = text.replace(/\\$/, "") + " " + lines[++i].trim();
      depth = (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0);
    }
    out.push(text.trim());
  }
  return out;
}

/** Blank out comments and string bodies, preserving offsets and line structure,
 *  so line-oriented matching can't be fooled by a docstring. */
function stripCommentsAndStrings(source: string): string {
  const chars = source.split("");
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") chars[i++] = " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(source, i);
      for (let j = i; j < end; j++) if (chars[j] !== "\n") chars[j] = " ";
      i = end;
      continue;
    }
    i++;
  }
  return chars.join("");
}

// ── Reference at the caret ───────────────────────────────────────────────────

/** The name under the caret, with its source range and dotted qualifier. */
export type PyRef = PyToken;

/** The identifier the caret sits in (or immediately after), or null. */
export function pythonRefAt(source: string, caret: number): PyRef | null {
  for (const t of pythonTokens(source)) {
    if (caret >= t.start && caret <= t.end) return t;
    if (t.start > caret) break; // tokens are in source order
  }
  return null;
}

/**
 * The source ranges to underline as ctrl-clickable (#49's `linkRanges` contract).
 *
 * Only names this resolver can actually *follow* are underlined — a name defined
 * in this file, a name imported into it, or an attribute of an imported module.
 * That keeps the affordance honest: if it's underlined, clicking it lands
 * somewhere. Definition sites themselves are excluded (jumping from `def foo` to
 * `def foo` is a no-op that would make every definition look like a link).
 */
export function pythonLinkRanges(source: string): { start: number; end: number }[] {
  const defs = findPythonDefs(source);
  const defNames = new Set(defs.map((d) => d.name));
  // Every definition site — `def`/`class` AND a module-level binding. A name is
  // not a link where it is being *defined*: the jump would land on itself.
  const defSites = new Set(defs.map((d) => `${d.line}:${d.name}`));

  const imports = parsePythonImports(source);
  const importedNames = new Set(imports.map((i) => i.local));
  const importedModules = new Set(imports.filter((i) => i.symbol === "").map((i) => i.local));

  // Line number of each offset, so a def site can be excluded by (line, name).
  const lineOf = lineIndex(source);

  const out: { start: number; end: number }[] = [];
  for (const t of pythonTokens(source)) {
    if (PY_KEYWORDS.has(t.name)) continue;

    if (t.qualifier != null) {
      // `mod.thing` — followable only when `mod` is an imported module, or when
      // it is `self` (then `thing` is a method of the class in THIS file).
      if (importedModules.has(t.qualifier) || t.qualifier === "self") {
        if (t.qualifier === "self" && !defNames.has(t.name)) continue;
        out.push({ start: t.start, end: t.end });
      }
      continue;
    }

    if (importedNames.has(t.name)) {
      out.push({ start: t.start, end: t.end });
      continue;
    }
    if (defNames.has(t.name) && !defSites.has(`${lineOf(t.start)}:${t.name}`)) {
      out.push({ start: t.start, end: t.end });
    }
  }
  return out;
}

/** A function mapping a source offset to its 1-based line number. */
function lineIndex(source: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ── Module → file ────────────────────────────────────────────────────────────

/**
 * The files an import could name, best candidate first.
 *
 * A relative import (`level > 0`) is anchored at this file's directory, walking
 * up one level per extra dot — unambiguous. An absolute one is genuinely
 * ambiguous without the interpreter's `sys.path`, so we probe the roots a project
 * actually uses, in order: the project root (flat layout), a `src/` root
 * (src-layout), and finally the importing file's own directory (scripts that sit
 * beside their modules). Each root yields both `pkg/mod.py` and the package form
 * `pkg/mod/__init__.py`.
 */
export function modulePathCandidates(
  imp: Pick<PyImport, "module" | "level">,
  filePath: string,
  projectRoot: string,
): string[] {
  const parts = imp.module ? imp.module.split(".") : [];

  const roots: string[] = [];
  if (imp.level > 0) {
    // `.` = this file's package; each extra dot climbs one more.
    let base = dirname(filePath) || "/";
    for (let i = 1; i < imp.level; i++) base = dirname(base) || base;
    roots.push(base);
  } else {
    if (projectRoot) {
      roots.push(projectRoot);
      roots.push(resolvePath(projectRoot, "src"));
    }
    roots.push(dirname(filePath) || "/");
  }

  const out: string[] = [];
  for (const root of roots) {
    // A bare `from . import x` names the package directory itself.
    const base = parts.length ? resolvePath(root, parts.join("/")) : root;
    if (parts.length) out.push(`${base}.py`);
    out.push(resolvePath(base, "__init__.py"));
  }
  return [...new Set(out)];
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Where a definition lives: an absolute path and a 1-based caret target. */
export interface PyLocation {
  path: string;
  line: number;
  column: number;
}

/** Injected file access, so resolution is testable without a host. Returns null
 *  when the path does not exist (or can't be read) — reading a candidate IS the
 *  existence check, since the content is needed anyway. */
export type PyReader = (path: string) => Promise<string | null>;

/**
 * Resolve the name at `caret` to its definition — the whole point of ctrl+click.
 *
 * The cases, in the order they are tried:
 *  - `self.method()` → the `def` in this file's class.
 *  - `mod.thing` where `mod` was imported → `thing`'s def in the module's file.
 *  - a name from `from mod import name` → its def in the module's file; failing
 *    that, `mod/name.py` (the form where the "symbol" is itself a submodule).
 *  - an imported module name → the top of that module's file.
 *  - anything else defined in this file → its def here.
 *
 * Returns null when nothing resolves — the caller must treat that as "not a
 * link" rather than guessing.
 */
export async function resolvePythonDefinition(
  source: string,
  caret: number,
  filePath: string,
  projectRoot: string,
  read: PyReader,
): Promise<PyLocation | null> {
  const ref = pythonRefAt(source, caret);
  if (!ref || PY_KEYWORDS.has(ref.name)) return null;

  const imports = parsePythonImports(source);
  const localDef = (name: string): PyLocation | null => {
    const d = findDef(source, name);
    return d ? { path: filePath, line: d.line, column: d.column } : null;
  };

  // `self.method` — a method of a class in this very file.
  if (ref.qualifier === "self") return localDef(ref.name);

  // `mod.thing` — follow `mod` to its file, then find `thing` in it.
  if (ref.qualifier != null) {
    const mod = imports.find((i) => i.local === ref.qualifier && i.symbol === "");
    if (!mod) return null;
    return await defInModule(mod, ref.name, filePath, projectRoot, read, new Set());
  }

  const imported = imports.find((i) => i.local === ref.name);
  if (imported) {
    if (imported.symbol) {
      // `from mod import name` — `name`'s def in mod, else mod/name.py.
      const hit = await defInModule(
        imported,
        imported.symbol,
        filePath,
        projectRoot,
        read,
        new Set(),
      );
      if (hit) return hit;
      const asModule: PyImport = {
        ...imported,
        module: imported.module
          ? `${imported.module}.${imported.symbol}`
          : imported.symbol,
      };
      return await moduleHead(asModule, filePath, projectRoot, read);
    }
    // `import mod` — open the module itself.
    return await moduleHead(imported, filePath, projectRoot, read);
  }

  return localDef(ref.name);
}

/**
 * `name`'s definition inside `imp`'s module file, or null.
 *
 * Follows one hop of re-export (`__init__.py` doing `from .impl import thing` is
 * the single most common shape in real packages), which makes the recursion able
 * to cycle: `a` re-exports from `b` while `b` imports from `a` is legal Python and
 * happens. `seen` is what makes that terminate — without it a circular re-export
 * hangs the click.
 */
async function defInModule(
  imp: PyImport,
  name: string,
  filePath: string,
  projectRoot: string,
  read: PyReader,
  seen: Set<string>,
): Promise<PyLocation | null> {
  for (const candidate of modulePathCandidates(imp, filePath, projectRoot)) {
    const visitKey = `${candidate}#${name}`;
    if (seen.has(visitKey)) continue;
    seen.add(visitKey);

    const text = await read(candidate);
    if (text == null) continue;
    const d = findDef(text, name);
    if (d) return { path: candidate, line: d.line, column: d.column };
    // The module exists but doesn't define the name — it may re-export it.
    const via = parsePythonImports(text).find((i) => i.local === name && i.symbol);
    if (via) {
      const hit = await defInModule(via, via.symbol, candidate, projectRoot, read, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/** The top of `imp`'s module file, or null when no candidate exists. */
async function moduleHead(
  imp: PyImport,
  filePath: string,
  projectRoot: string,
  read: PyReader,
): Promise<PyLocation | null> {
  for (const candidate of modulePathCandidates(imp, filePath, projectRoot)) {
    if ((await read(candidate)) != null) return { path: candidate, line: 1, column: 0 };
  }
  return null;
}
