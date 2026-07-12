/**
 * Dependency-free syntax highlighter for the built-in code viewer (TODO Group K
 * #40). It turns a file's source into safe HTML where tokens are wrapped in
 * `<span class="tok-*">` elements; the code viewer renders that behind a
 * transparent <textarea> so the file stays editable while showing colour.
 *
 * Like the sibling `markdown.ts`, this is intentionally a focused, hand-written
 * subset rather than a full grammar per language: it recognises comments,
 * strings, numbers, and keyword/type/function identifiers, which is what carries
 * most of the visual signal. It is driven by a tiny per-language `LangSpec`
 * (comment markers + keyword/type tables) plus a dedicated markup tokenizer for
 * HTML/XML/SVG.
 *
 * SECURITY: the input is an arbitrary file's contents, so every run of text —
 * token or plain — is HTML-escaped before it enters the output. We only ever
 * emit our own `<span>` tags with fixed class names; nothing from the source is
 * interpreted as markup. Keep this invariant if extending.
 */

export type Lang =
  | "js"
  | "rust"
  | "python"
  | "go"
  | "c"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "css"
  | "sql"
  | "tex"
  | "markup"
  | "markdown"
  | "plain";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

const set = (...words: string[]) => new Set(words);

interface LangSpec {
  /** Line-comment markers, longest-first if they share a prefix. */
  line: string[];
  /** Block-comment delimiters, if the language has them. */
  block?: [string, string];
  /** String delimiters. ` allows newlines; ' and " are single-line. */
  strings: string[];
  /** Python-style triple-quoted strings (multiline). */
  triple?: boolean;
  /** Shell/Perl-style `$name` variable interpolation. */
  sigil?: string;
  keywords: Set<string>;
  /** Constant literals coloured like keywords (true/false/null/…). */
  literals: Set<string>;
  types: Set<string>;
  /** Treat a string immediately followed by `:` as a key (JSON/YAML look). */
  keyStrings?: boolean;
}

// Control/declaration keywords. The JS table is a superset that also covers
// TypeScript so .ts/.tsx files highlight without a separate spec.
const JS_KW = set(
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let",
  "namespace", "new", "of", "package", "private", "protected", "public",
  "readonly", "return", "satisfies", "set", "static", "super", "switch", "this",
  "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield",
);
const JS_TYPES = set(
  "any", "boolean", "number", "object", "string", "symbol", "unknown", "never",
  "bigint", "Array", "Promise", "Record", "Map", "Set", "Partial", "Readonly",
);

const RUST_KW = set(
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
  "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
  "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
  "struct", "super", "trait", "type", "union", "unsafe", "use", "where", "while",
);
const RUST_TYPES = set(
  "bool", "char", "str", "String", "i8", "i16", "i32", "i64", "i128", "isize",
  "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "Vec", "Option",
  "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "Cow",
);

const PY_KW = set(
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case",
);
const PY_TYPES = set(
  "int", "float", "str", "bool", "bytes", "list", "dict", "set", "tuple",
  "object", "type", "None",
);

const GO_KW = set(
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
);
const GO_TYPES = set(
  "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr",
);

// A pragmatic shared table for the C-like family (C/C++/Java/C#/Swift/Kotlin/…).
const C_KW = set(
  "auto", "break", "case", "catch", "class", "const", "continue", "default",
  "delete", "do", "else", "enum", "extends", "extern", "final", "finally",
  "for", "goto", "if", "implements", "import", "inline", "instanceof",
  "interface", "namespace", "new", "operator", "override", "package", "private",
  "protected", "public", "register", "return", "sizeof", "static", "struct",
  "super", "switch", "template", "this", "throw", "throws", "try", "typedef",
  "typename", "union", "using", "virtual", "volatile", "while",
);
const C_TYPES = set(
  "bool", "char", "double", "float", "int", "long", "short", "signed",
  "unsigned", "void", "wchar_t", "size_t", "string", "String", "var", "let",
  "fun", "val",
);

const SHELL_KW = set(
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "return", "export",
  "local", "readonly", "declare", "set", "unset", "source",
);

const SQL_KW = set(
  "select", "from", "where", "and", "or", "not", "insert", "into", "values",
  "update", "set", "delete", "create", "table", "drop", "alter", "add", "column",
  "primary", "key", "foreign", "references", "join", "left", "right", "inner",
  "outer", "on", "as", "group", "by", "order", "having", "limit", "offset",
  "distinct", "union", "all", "index", "view", "trigger", "default", "null",
  "is", "in", "like", "between", "exists", "case", "when", "then", "else", "end",
);

const TOML_KW = set("true", "false");

const SPECS: Record<Exclude<Lang, "markup" | "tex" | "markdown" | "plain">, LangSpec> = {
  js: { line: ["//"], block: ["/*", "*/"], strings: ['"', "'", "`"], keywords: JS_KW, literals: set("true", "false", "null", "undefined", "NaN", "Infinity"), types: JS_TYPES },
  rust: { line: ["//"], block: ["/*", "*/"], strings: ['"'], keywords: RUST_KW, literals: set("true", "false", "None", "Some", "Ok", "Err"), types: RUST_TYPES },
  python: { line: ["#"], strings: ['"', "'"], triple: true, keywords: PY_KW, literals: set("True", "False", "None", "self", "cls"), types: PY_TYPES },
  go: { line: ["//"], block: ["/*", "*/"], strings: ['"', "`"], keywords: GO_KW, literals: set("true", "false", "nil", "iota"), types: GO_TYPES },
  c: { line: ["//"], block: ["/*", "*/"], strings: ['"', "'"], keywords: C_KW, literals: set("true", "false", "null", "nullptr", "NULL", "nil"), types: C_TYPES },
  shell: { line: ["#"], strings: ['"', "'"], sigil: "$", keywords: SHELL_KW, literals: set("true", "false"), types: set() },
  json: { line: [], strings: ['"'], keywords: set(), literals: set("true", "false", "null"), types: set(), keyStrings: true },
  yaml: { line: ["#"], strings: ['"', "'"], keywords: set(), literals: set("true", "false", "null", "yes", "no", "on", "off"), types: set(), keyStrings: true },
  toml: { line: ["#", ";"], strings: ['"', "'"], keywords: set(), literals: TOML_KW, types: set(), keyStrings: true },
  css: { line: ["//"], block: ["/*", "*/"], strings: ['"', "'"], keywords: set(), literals: set(), types: set() },
  sql: { line: ["--"], block: ["/*", "*/"], strings: ["'", '"'], keywords: SQL_KW, literals: set("true", "false", "null"), types: set() },
};

const EXT_LANG: Record<string, Lang> = {
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".ts": "js",
  ".tsx": "js", ".vue": "js", ".svelte": "js", ".astro": "js",
  ".rs": "rust",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".c": "c", ".h": "c", ".cpp": "c", ".cc": "c", ".cxx": "c", ".hpp": "c",
  ".java": "c", ".kt": "c", ".kts": "c", ".cs": "c", ".swift": "c", ".m": "c",
  ".mm": "c", ".scala": "c", ".dart": "c", ".php": "c", ".groovy": "c",
  ".gradle": "c",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
  ".ps1": "shell", ".bat": "shell",
  ".json": "json", ".jsonc": "json", ".json5": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".ini": "toml", ".cfg": "toml", ".conf": "toml",
  ".env": "toml", ".properties": "toml",
  ".css": "css", ".scss": "css", ".sass": "css", ".less": "css",
  ".sql": "sql",
  ".tex": "tex", ".sty": "tex", ".cls": "tex", ".ltx": "tex",
  ".html": "markup", ".htm": "markup", ".xml": "markup", ".svg": "markup",
  ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown",
  ".mkd": "markdown", ".mdx": "markdown",
};

const FILENAME_LANG: Record<string, Lang> = {
  dockerfile: "shell",
  ".gitignore": "shell",
  ".env": "toml",
  ".npmrc": "toml",
  ".editorconfig": "toml",
};

/** The highlighter language for a path, or "plain" when none applies (the viewer
 *  then shows the file uncoloured). Matched by extension first, then by a few
 *  well-known extensionless filenames. */
export function languageForPath(path: string): Lang {
  const name = (path.split(/[/\\]/).filter(Boolean).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  // A leading-dot name (".gitignore") has no extension; only a dot past index 0
  // separates a real extension.
  const ext = dot > 0 ? name.slice(dot) : "";
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext];
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  return "plain";
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Read a string literal starting at `i` (on the opening delimiter). Returns the
 *  raw slice (including delimiters) and the index past it. Honours backslash
 *  escapes; single-line unless `multiline`. */
function readString(code: string, i: number, quote: string, multiline: boolean): [string, number] {
  const start = i;
  i += 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) { i += 1; break; }
    if (c === "\n" && !multiline) break;
    i += 1;
  }
  return [code.slice(start, i), i];
}

/** Read a number literal starting at `i`. Permissive: covers hex/binary/octal,
 *  floats, exponents, and digit separators (`_`). */
function readNumber(code: string, i: number): [string, number] {
  const start = i;
  i += 1;
  while (i < code.length) {
    const c = code[i];
    if (/[0-9a-fA-FxXoObB._]/.test(c)) { i += 1; continue; }
    if ((c === "+" || c === "-") && /[eE]/.test(code[i - 1])) { i += 1; continue; }
    break;
  }
  return [code.slice(start, i), i];
}

/** Tokenize generic code per `spec` into safe highlighted HTML. */
function scanCode(code: string, spec: LangSpec): string {
  let out = "";
  let i = 0;
  const n = code.length;

  const atLineComment = () => spec.line.find((m) => code.startsWith(m, i));

  while (i < n) {
    const c = code[i];

    // Line comment → to end of line.
    const lc = atLineComment();
    if (lc) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Block comment.
    if (spec.block && code.startsWith(spec.block[0], i)) {
      const close = code.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = close === -1 ? n : close + spec.block[1].length;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Strings (including Python triple-quoted).
    if (spec.strings.includes(c)) {
      if (spec.triple && code.startsWith(c.repeat(3), i)) {
        const close = code.indexOf(c.repeat(3), i + 3);
        const stop = close === -1 ? n : close + 3;
        out += span("string", code.slice(i, stop));
        i = stop;
        continue;
      }
      const [str, next] = readString(code, i, c, c === "`");
      // JSON/YAML look: a string that is the key of a mapping reads as a prop.
      if (spec.keyStrings) {
        let j = next;
        while (j < n && (code[j] === " " || code[j] === "\t")) j += 1;
        out += span(code[j] === ":" ? "prop" : "string", str);
      } else {
        out += span("string", str);
      }
      i = next;
      continue;
    }

    // Shell/Perl `$variable`.
    if (spec.sigil && c === spec.sigil) {
      let j = i + 1;
      if (code[j] === "{") { j = code.indexOf("}", j); j = j === -1 ? n : j + 1; }
      else while (j < n && isIdentPart(code[j])) j += 1;
      out += span("type", code.slice(i, j));
      i = j;
      continue;
    }

    // Numbers (a leading digit, or a dot directly before one).
    if (isDigit(c) || (c === "." && isDigit(code[i + 1] ?? ""))) {
      const [num, next] = readNumber(code, i);
      out += span("num", num);
      i = next;
      continue;
    }

    // Identifiers / keywords / types / function calls.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(code[j])) j += 1;
      const word = code.slice(i, j);
      if (spec.keywords.has(word) || spec.literals.has(word)) {
        out += span("keyword", word);
      } else if (spec.types.has(word) || /^[A-Z]/.test(word)) {
        out += span("type", word);
      } else {
        // A name immediately followed by `(` is a call/definition.
        let k = j;
        while (k < n && (code[k] === " " || code[k] === "\t")) k += 1;
        out += code[k] === "(" ? span("func", word) : escapeHtml(word);
      }
      i = j;
      continue;
    }

    // Anything else (punctuation, whitespace) passes through, escaped.
    out += escapeHtml(c);
    i += 1;
  }

  return out;
}

const MARKUP_COMMENT = ["<!--", "-->"] as const;

/** Tokenize HTML/XML/SVG: comments, tags + attributes, and quoted values, with
 *  the text between tags left plain. */
function scanMarkup(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    if (code.startsWith(MARKUP_COMMENT[0], i)) {
      const close = code.indexOf(MARKUP_COMMENT[1], i);
      const stop = close === -1 ? n : close + MARKUP_COMMENT[1].length;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    if (code[i] === "<") {
      const close = code.indexOf(">", i);
      const stop = close === -1 ? n : close + 1;
      out += scanTag(code.slice(i, stop));
      i = stop;
      continue;
    }

    const next = code.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += escapeHtml(code.slice(i, stop));
    i = stop;
  }

  return out;
}

/** Highlight a single `<...>` tag: the `<`/`</`/`>` punctuation, the tag name,
 *  attribute names, and quoted attribute values. */
function scanTag(tag: string): string {
  let out = "";
  let i = 0;
  const n = tag.length;

  // Opening punctuation and the tag name.
  out += escapeHtml(tag[i]); // '<'
  i += 1;
  if (tag[i] === "/") { out += "/"; i += 1; }
  let j = i;
  while (j < n && /[^\s/>]/.test(tag[j])) j += 1;
  if (j > i) out += span("tag", tag.slice(i, j));
  i = j;

  // Attributes and values until '>'.
  while (i < n) {
    const c = tag[i];
    if (c === '"' || c === "'") {
      const [str, next] = readString(tag, i, c, false);
      out += span("string", str);
      i = next;
    } else if (/[A-Za-z_:@-]/.test(c)) {
      let k = i + 1;
      while (k < n && /[^\s=/>]/.test(tag[k])) k += 1;
      out += span("attr", tag.slice(i, k));
      i = k;
    } else {
      out += escapeHtml(c);
      i += 1;
    }
  }

  return out;
}

/** Tokenize LaTeX/TeX: `%` line comments, `\control` sequences, the environment
 *  name inside `\begin{…}`/`\end{…}`, and bare numbers. Math stays plain text so
 *  commands inside `$…$` (e.g. `\frac`) still colour as commands. */
function scanTex(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];

    // Comment to end of line. A literal percent is written `\%`, which the
    // control-sequence branch consumes first, so any `%` reaching here opens one.
    if (c === "%") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Control sequence: `\` then either a run of letters (`\section`) or a single
    // non-letter (`\\`, `\%`, `\{`).
    if (c === "\\") {
      let j = i + 1;
      if (j < n && /[A-Za-z]/.test(code[j])) {
        while (j < n && /[A-Za-z]/.test(code[j])) j += 1;
      } else {
        j = Math.min(j + 1, n);
      }
      const cmd = code.slice(i, j);
      out += span("keyword", cmd);
      i = j;

      // `\begin{env}` / `\end{env}` → colour the environment name as a type.
      if ((cmd === "\\begin" || cmd === "\\end") && code[i] === "{") {
        const close = code.indexOf("}", i);
        if (close !== -1) {
          out += escapeHtml("{") + span("type", code.slice(i + 1, close)) + escapeHtml("}");
          i = close + 1;
        }
      }
      continue;
    }

    if (isDigit(c)) {
      const [num, next] = readNumber(code, i);
      out += span("num", num);
      i = next;
      continue;
    }

    out += escapeHtml(c);
    i += 1;
  }

  return out;
}

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/** Highlight the inline span content of one markdown line: code spans, links/
 *  images, and `**strong**` / `*emphasis*` runs. Emphasis uses CommonMark-style
 *  flanking checks (no space just inside the markers, underscores not intra-word)
 *  so stray `*`/`_` in prose or `2 * 3` math don't get coloured. Everything not
 *  matched passes through HTML-escaped. */
function scanMarkdownInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Inline code: a run of N backticks closed by the same run.
    if (c === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks += 1;
      const close = text.indexOf("`".repeat(ticks), i + ticks);
      if (close !== -1) {
        out += span("md-code", text.slice(i, close + ticks));
        i = close + ticks;
        continue;
      }
    }

    // Link `[text](url)` or image `![alt](url)`.
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const lb = c === "!" ? i + 1 : i;
      const rb = text.indexOf("]", lb + 1);
      if (rb !== -1 && text[rb + 1] === "(") {
        const rp = text.indexOf(")", rb + 2);
        if (rp !== -1) {
          if (c === "!") out += escapeHtml("!");
          out += escapeHtml("[") + span("md-link", text.slice(lb + 1, rb)) + escapeHtml("](");
          out += span("md-url", text.slice(rb + 2, rp)) + escapeHtml(")");
          i = rp + 1;
          continue;
        }
      }
    }

    // Strong: ** or __ (checked before emphasis so `**` wins over `*`).
    if (
      (c === "*" || c === "_") && text[i + 1] === c &&
      text[i + 2] !== undefined && text[i + 2] !== " " &&
      !(c === "_" && isWordChar(text[i - 1]))
    ) {
      const close = text.indexOf(c + c, i + 2);
      if (close !== -1 && text[close - 1] !== " " &&
          !(c === "_" && isWordChar(text[close + 2]))) {
        out += span("md-strong", text.slice(i, close + 2));
        i = close + 2;
        continue;
      }
    }

    // Emphasis: a single * or _.
    if (
      (c === "*" || c === "_") &&
      text[i + 1] !== undefined && text[i + 1] !== " " && text[i + 1] !== c &&
      !(c === "_" && isWordChar(text[i - 1]))
    ) {
      const close = text.indexOf(c, i + 1);
      if (close !== -1 && text[close - 1] !== " " &&
          !(c === "_" && isWordChar(text[close + 1]))) {
        out += span("md-em", text.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }

    out += escapeHtml(c);
    i += 1;
  }

  return out;
}

/** Tokenize Markdown line-by-line: fenced code blocks, ATX headings, horizontal
 *  rules, blockquote/list line prefixes, plus the inline spans handled by
 *  {@link scanMarkdownInline}. A focused subset, like the other scanners. */
function scanMarkdown(code: string): string {
  const lines = code.split("\n");
  let out = "";
  let inFence = false;
  let fence = "";

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const nl = li < lines.length - 1 ? "\n" : "";

    // Inside a fenced code block: paint verbatim until a matching close fence.
    if (inFence) {
      out += span("md-code", line) + nl;
      if (line.trimStart().startsWith(fence)) inFence = false;
      continue;
    }

    // Opening code fence (``` or ~~~, optionally with an info string).
    const open = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (open) {
      inFence = true;
      fence = open[1].slice(0, 3);
      out += span("md-code", line) + nl;
      continue;
    }

    // ATX heading (#…######).
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
      out += span("md-heading", line) + nl;
      continue;
    }

    // Horizontal rule (three or more -, *, or _).
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out += span("md-hr", line) + nl;
      continue;
    }

    // Leading blockquote markers and/or a list marker, then inline content.
    let rest = line;
    let prefix = "";
    const bq = /^(\s{0,3}(?:>\s?)+)/.exec(rest);
    if (bq) {
      prefix += span("md-quote", bq[1]);
      rest = rest.slice(bq[1].length);
    }
    const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(rest);
    if (list) {
      prefix += escapeHtml(list[1]) + span("md-list", list[2]) + escapeHtml(list[3]);
      rest = rest.slice(list[0].length);
    }

    out += prefix + scanMarkdownInline(rest) + nl;
  }

  return out;
}

/** Largest source we will highlight, in characters. Beyond this the viewer falls
 *  back to plain text so editing a huge file stays responsive (re-highlight runs
 *  on every keystroke). */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/**
 * Highlight `code` for `lang`, returning safe HTML, or `null` when there is
 * nothing to do — an unknown/`"plain"` language or a file over
 * `HIGHLIGHT_MAX_CHARS` — so the caller can render the raw text instead.
 */
export function highlight(code: string, lang: Lang): string | null {
  if (lang === "plain") return null;
  if (code.length > HIGHLIGHT_MAX_CHARS) return null;
  if (lang === "markup") return scanMarkup(code);
  if (lang === "tex") return scanTex(code);
  if (lang === "markdown") return scanMarkdown(code);
  return scanCode(code, SPECS[lang]);
}
