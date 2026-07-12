import { invoke } from "@tauri-apps/api/core";
import { internalViewerFor, type FileEntry, type InternalViewer } from "./fileUtils";
import { basename, dirname, isAbsolute, normalizePath, resolvePath } from "../paths";

/** Which TeX tools are on PATH; mirrors the backend `TexCapability`. */
export type TexCapability = {
  available: boolean;
  engines: string[];
  bibtex: boolean;
  latexmk: boolean;
};

/** Result of `compile_tex`; mirrors the backend `TexCompileResult`. */
export type TexCompileResult = {
  success: boolean;
  pdf_path: string | null;
  engine: string;
  log: string;
  /** True when the build ran with shell-escape (`\write18`) active behind our
   *  back (system texmf.cnf / latexmkrc). Surfaced as a warning in the viewer. */
  shell_escape: boolean;
};

// TeX tooling is PATH-global, so probe the backend once per app run and share
// the result across every consumer (the FileTree context menu and the in-tab
// LaTeX viewer).
let texCapPromise: Promise<TexCapability> | null = null;

export function getTexCapability(): Promise<TexCapability> {
  if (!texCapPromise) {
    texCapPromise = invoke<TexCapability>("tex_capability").catch(
      () => ({ available: false, engines: [], bibtex: false, latexmk: false }),
    );
  }
  return texCapPromise;
}

/** Last meaningful line of a build log, for a terse error message. */
export function lastLogLine(log: string): string {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** A parsed compile error with its source location, for jump-to-error. */
export type TexError = {
  /** File the error is in, exactly as the log named it (may be relative to the
   *  compile dir, or absolute). Resolve with {@link resolveTexErrorPath}. */
  file: string;
  /** 1-based source line. */
  line: number;
  /** The error message (without the `file:line:` prefix). */
  message: string;
};

// `file:line: message`, the form TeX uses under `-file-line-error` (which Eldrun
// always passes). The file part is non-greedy so the FIRST `:<digits>:` wins,
// and the line must be followed by `:` then a space to avoid matching e.g.
// Windows drive letters or `l.12` context dumps.
const FILE_LINE_ERROR = /^(.+?):(\d+): (.*)$/;

/** Parse `compile_tex`'s log into the list of errors TeX reported, in order.
 *  Relies on the `-file-line-error` format Eldrun compiles with. Duplicate
 *  file+line+message lines (TeX can repeat them) are collapsed. */
export function parseTexErrors(log: string): TexError[] {
  const out: TexError[] = [];
  const seen = new Set<string>();
  for (const raw of log.split("\n")) {
    const m = FILE_LINE_ERROR.exec(raw.trimEnd());
    if (!m) continue;
    const file = m[1].trim();
    const line = Number(m[2]);
    const message = m[3].trim();
    // Skip degenerate matches: empty file token, or a path with no extension
    // and a space (those are usually prose lines that happen to contain ": N:").
    if (!file || !Number.isFinite(line) || line < 1) continue;
    const key = `${file}:${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, message });
  }
  return out;
}

/** Resolve a {@link TexError}'s `file` against the directory the build ran in
 *  (the TeX root's folder) into an absolute path the editor can open. Absolute
 *  paths and `./`-relative paths are both handled. */
export function resolveTexErrorPath(rootDir: string, file: string): string {
  // Absolute (POSIX `/x`, Windows `C:\x` / UNC) passes through unchanged.
  if (isAbsolute(file)) return file;
  const rel = file.replace(/^\.[/\\]+/, "");
  return rootDir ? resolvePath(rootDir, rel) : rel;
}

// --- SyncTeX forward/reverse search -----------------------------------------

/** A source location from SyncTeX reverse search; mirrors backend `SyncSource`. */
export type SyncSource = {
  /** Absolute path to the source `.tex`. */
  input: string;
  /** 1-based source line. */
  line: number;
  /** 1-based source column (0 when SyncTeX did not report one). */
  column: number;
};

/** A PDF box from SyncTeX forward search; mirrors backend `SyncRect`. Units are
 *  big points (72 dpi) measured from the page's top-left corner. */
export type SyncRect = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Reverse search: which source line produced `(x, y)` (big points from the
 *  page top-left) on `page` of `pdf`. Resolves to null on any error / no hit. */
export function synctexEdit(
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SyncSource | null> {
  return invoke<SyncSource | null>("synctex_edit", { pdf, page, x, y }).catch(() => null);
}

/** Forward search: every SyncTeX record (`input:line:column` → the line's
 *  constituent boxes / wrapped rows). Resolves to `[]` on any error / no hit. */
export function synctexView(
  pdf: string,
  input: string,
  line: number,
  column: number,
): Promise<SyncRect[]> {
  return invoke<SyncRect[]>("synctex_view", { pdf, input, line, column }).catch(() => []);
}

/**
 * SyncTeX forward search is sensitive to how the source path is spelled — it
 * matches the `-i` input against the path string recorded at compile time, which
 * may be the absolute path, the name relative to the compile dir, or a bare
 * basename depending on the engine/version and how the file was passed in. Eldrun
 * compiles with the bare filename, so an absolute `-i` often fails to match. This
 * tries the absolute path, the path relative to the build dir, and the basename
 * (deduped, in that order) and returns the first spelling that yields records —
 * so forward search works regardless of which spelling SyncTeX stored. Returns
 * `[]` only when none match.
 */
export async function synctexViewBest(
  pdf: string,
  input: string,
  rootDir: string,
  line: number,
  column: number,
): Promise<SyncRect[]> {
  for (const cand of forwardInputCandidates(input, rootDir)) {
    const recs = await synctexView(pdf, cand, line, column);
    if (recs.length) return recs;
  }
  return [];
}

/**
 * The clicked column's position along its source line, as a fraction in `[0, 1]`.
 * `column` is 1-based. Used to pick which SyncTeX record (the line's boxes /
 * wrapped rows, left-to-right then top-to-bottom) the caret lands in — so a click
 * late on a line that wrapped maps to the lower row, not the first box SyncTeX
 * happened to list. A blank/one-char line maps to 0. Pure / unit-tested.
 */
export function sourceColumnFraction(text: string, line: number, column: number): number {
  const start = lineStartOffset(text, line);
  const nl = text.indexOf("\n", start);
  const len = (nl === -1 ? text.length : nl) - start;
  if (len <= 1) return 0;
  // column is 1-based; clamp into [0, len] then normalise by the line length.
  const c = Math.max(0, Math.min(column - 1, len));
  return c / len;
}

/**
 * Pick the SyncTeX forward-search record the clicked column lands in. The records
 * are the line's constituent boxes (and, when the source line wrapped, one row
 * per visual line); read in order (top-to-bottom, then left-to-right) their
 * widths tile the line, so the box covering `frac` of the cumulative horizontal
 * advance is the one under the caret. This resolves the ROW under wrapping (which
 * pure text matching could not), leaving the exact word to {@link refineToWord}.
 * Returns null only for an empty list. Pure / unit-tested.
 */
export function pickSyncRect(records: SyncRect[], frac: number): SyncRect | null {
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  const sorted = [...records].sort((a, b) => a.y - b.y || a.x - b.x);
  // Zero-width boxes (SyncTeX occasionally omits W) count as one unit so the
  // walk still advances and never divides by zero.
  const widths = sorted.map((r) => (r.w > 0 ? r.w : 1));
  const total = widths.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    const mid = acc + widths[i] / 2;
    if (mid / total >= frac) return sorted[i];
    acc += widths[i];
  }
  return sorted[sorted.length - 1];
}

/** The source-path spellings to try for SyncTeX forward search, in order: the
 *  absolute path, the path relative to the build dir, and the bare basename
 *  (deduped). Pure / unit-tested — {@link synctexViewBest} feeds each to
 *  `synctex view -i` until one matches. */
export function forwardInputCandidates(input: string, rootDir: string): string[] {
  const rel = forwardRelative(rootDir, input);
  const base = basename(input);
  // SyncTeX may have stored the path with a `./` prefix (a common engine
  // spelling); try those forms too.
  const out: string[] = [input];
  for (const r of [rel, base]) {
    if (!r) continue;
    out.push(r, `./${r}`);
  }
  return Array.from(new Set(out));
}

/** `file` expressed relative to directory `dir`, using forward slashes (the
 *  spelling SyncTeX records on every platform), or null when `file` is not under
 *  `dir`. Accepts either separator on either argument so it is correct for native
 *  Windows paths (`C:\proj` + `C:\proj\ch\x.tex` → `ch/x.tex`) as well as POSIX. */
function forwardRelative(dir: string, file: string): string | null {
  const trimmed = dir.replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const nDir = trimmed.replace(/\\/g, "/");
  const nFile = file.replace(/\\/g, "/");
  return nFile.startsWith(nDir + "/") ? nFile.slice(nDir.length + 1) : null;
}

/** Resolve the file that should actually be compiled for `path` (a child file
 *  redirects to its main document). Falls back to `path` on any error. */
export function resolveTexRoot(path: string): Promise<string> {
  return invoke<string>("resolve_tex_root", { path })
    .then((r) => (typeof r === "string" && r ? r : path))
    .catch(() => path);
}

/**
 * Map a click on a pdf.js page canvas to SyncTeX big points (72 dpi from the
 * page's top-left). At pdf.js `scale = 1` the viewport unit already equals one
 * big point, so dividing the CSS-pixel offset within the page rect by `scale`
 * recovers big points. `rect` is the page canvas's bounding rect.
 */
export function pdfPointToBigPoints(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
  scale: number,
): { x: number; y: number } {
  return {
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale,
  };
}

/** Inverse of {@link pdfPointToBigPoints}: a SyncTeX box in big points → CSS
 *  pixels for positioning a highlight overlay over a page at `scale`. */
export function bigPointsToCssRect(
  rect: SyncRect,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * scale,
    top: rect.y * scale,
    width: rect.w * scale,
    height: rect.h * scale,
  };
}

/**
 * Find every occurrence of `query` in a PDF page's extracted text runs,
 * returning one entry per match — each a list of big-point boxes ({@link
 * SyncRect}) covering it. Most matches yield a single box; a match that straddles
 * text-run boundaries yields one box per run it touches. Case-insensitive unless
 * `caseSensitive`. The runs are concatenated in reading order exactly as pdf.js
 * emits them (no inserted separators), so a query matches the text a reader sees;
 * each run's box is sliced by the matched character span using its uniform
 * per-character width. An empty query (or no items) yields no matches. Pure —
 * unit-tested; the caller derives `items` via `getTextContent()` at scale 1, the
 * same boxes SyncTeX word-refinement uses, so highlights sit on the glyphs.
 */
export function pdfPageMatches(
  items: TextItemBox[],
  page: number,
  query: string,
  caseSensitive: boolean,
): SyncRect[][] {
  if (!query) return [];
  // Concatenate the runs, remembering each run's start offset in the joined text.
  let text = "";
  const starts: number[] = [];
  for (const it of items) {
    starts.push(text.length);
    text += it.str;
  }
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: SyncRect[][] = [];
  for (let from = 0; ; ) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + needle.length;
    const rects: SyncRect[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s = starts[i];
      const e = s + it.str.length;
      if (e <= idx || s >= end || it.w <= 0 || it.str.length === 0) continue;
      const a = Math.max(idx, s) - s; // first matched char within this run
      const b = Math.min(end, e) - s; // one past the last matched char
      const charW = it.w / it.str.length;
      rects.push({ page, x: it.x + a * charW, y: it.y, w: (b - a) * charW, h: it.h });
    }
    if (rects.length) out.push(rects);
    from = end; // non-overlapping, mirroring findMatches
  }
  return out;
}

/** Character offset of the start of (1-based) `line` in `text`. Clamped to the
 *  valid range; a line past the end maps to the text length. */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  let seen = 1;
  while (seen < line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    seen += 1;
  }
  return offset;
}

/** 1-based {line, column} of character `offset` in `text` (column counts from
 *  the start of the line). Used to feed SyncTeX forward search from the caret. */
export function offsetToLineCol(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

// --- Word-precise forward search (Ctrl+Click → exact word in the PDF) ---------
//
// SyncTeX forward search resolves a caret to a line-ish *box* in the PDF, which
// is often a whole line. We narrow that box to the exact clicked word. A single
// word is ambiguous (a common word like "the" appears all over), so the matcher
// also takes the NEIGHBOURING words around the caret and prefers the occurrence
// where that surrounding phrase agrees — disambiguating which "the" to box.
// `phraseAt` pulls the word + its neighbours out of the source; `refineToWord`
// locates the clicked word in the PDF text using that context.
//
// When the surrounding phrase ITSELF repeats on the line (boilerplate, list
// items, "the … the …"), neighbour matching ties and the old tiebreak — nearest
// the line box's horizontal centre — picked an occurrence essentially at random.
// The fix is a signal duplicates can't share: the clicked word's ORDINAL
// POSITION in its line. `phraseAt` records the caret's word index on the source
// line (`lineIndex`) and `refineToWord` compares it to each PDF occurrence's
// index within its visual row, so the occurrence at the matching position wins.

/** A run of letters/digits (with internal hyphens/apostrophes), so a click in
 *  the middle of "framework" still selects the whole word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lowercase + strip leading/trailing non-alphanumerics, so a source word and a
 *  PDF token with attached punctuation/quotes compare equal ("(word)" → "word"). */
function normWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/** Natural-language words in `s` after stripping TeX control sequences / markup,
 *  so only text that actually appears in the PDF survives (`\emph{x}` → `x`). */
function texWords(s: string): string[] {
  const stripped = s
    .replace(/\\[a-zA-Z]+\*?/g, " ") // control words: \emph, \textbf, …
    .replace(/\\[^a-zA-Z]/g, " ") // control symbols: \&, \%, …
    .replace(/[{}$&%#~^_\\]/g, " "); // braces, math, other specials
  const out: string[] = [];
  const re = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) out.push(m[0].toLowerCase());
  return out;
}

/**
 * The natural-language word under `caret` in `source` — a maximal run of
 * letter/digit characters around the caret (internal hyphens/apostrophes kept) —
 * or null when the caret isn't on a word (whitespace, punctuation, a backslash).
 * Pure / unit-tested.
 */
export function wordAt(source: string, caret: number): string | null {
  if (caret < 0 || caret > source.length) return null;
  const isWord = (ch: string) => WORD_CHAR.test(ch) || ch === "-" || ch === "'" || ch === "’";
  let start = caret;
  let end = caret;
  while (start > 0 && isWord(source[start - 1])) start--;
  while (end < source.length && isWord(source[end])) end++;
  // Trim any leading/trailing connector chars so "word-" → "word".
  let s = source.slice(start, end);
  s = s.replace(/^[-'’]+/, "").replace(/[-'’]+$/, "");
  // Require at least one real word character (not a lone connector run).
  return WORD_CHAR.test(s) ? s : null;
}

/** The clicked word plus its same-line neighbours, for disambiguating which
 *  occurrence to highlight. `words` is the phrase in reading order (lowercased,
 *  markup stripped); `index` is the position of the clicked word within it.
 *  `lineIndex` is the clicked word's UNCAPPED ordinal among the natural-language
 *  words on its source line (0-based), used to break ties between repeated
 *  phrases by position rather than by proximity to the line centre. Optional so
 *  callers/tests can build a bare `{words, index}`; when absent `refineToWord`
 *  falls back to `index`. */
export interface CaretPhrase {
  words: string[];
  index: number;
  lineIndex?: number;
}

/**
 * Build a {@link CaretPhrase} for the caret: the clicked word plus up to `radius`
 * natural-language words on each side, staying on the same source line and
 * skipping TeX markup. Returns null when the caret isn't on a word. Pure /
 * unit-tested. Words are lowercased so matching is case-insensitive.
 */
export function phraseAt(source: string, caret: number, radius = 3): CaretPhrase | null {
  const clicked = wordAt(source, caret);
  if (!clicked) return null;
  const isWord = (ch: string) =>
    !!ch && (WORD_CHAR.test(ch) || ch === "-" || ch === "'" || ch === "’");
  let ws = caret;
  let we = caret;
  while (ws > 0 && isWord(source[ws - 1])) ws--;
  while (we < source.length && isWord(source[we])) we++;
  const lineStart = source.lastIndexOf("\n", ws - 1) + 1;
  const nl = source.indexOf("\n", we);
  const lineEnd = nl < 0 ? source.length : nl;
  const beforeAll = texWords(source.slice(lineStart, ws));
  const before = beforeAll.slice(-radius);
  const after = texWords(source.slice(we, lineEnd)).slice(0, radius);
  return {
    words: [...before, clicked.toLowerCase(), ...after],
    index: before.length,
    // Uncapped count of words ahead of the clicked one on its source line.
    lineIndex: beforeAll.length,
  };
}

/** A PDF page's extracted text run, positioned in big points (72 dpi) from the
 *  page's top-left — the same coordinate space as {@link SyncRect}. The caller
 *  derives these from pdf.js `getTextContent()` items at viewport scale 1. */
export interface TextItemBox {
  /** The run's text. */
  str: string;
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Run width. */
  w: number;
  /** Run height (≈ font size). */
  h: number;
}

/** A single positioned PDF word (normalised text + its box in big points). */
interface WordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Split each text run into positioned word boxes (whitespace-delimited tokens),
 *  estimating each token's box from its character span within the run. The box
 *  hugs the word's alphanumeric core: a token's attached punctuation/quotes
 *  ("(word)," → "word") is matched out by {@link normWord} for comparison, and
 *  trimmed off the box too so the highlight sits on the word, not the surround. */
function wordBoxes(items: TextItemBox[]): WordBox[] {
  const out: WordBox[] = [];
  for (const it of items) {
    if (!it.str || it.w <= 0) continue;
    const charW = it.w / it.str.length;
    const re = /\S+/g;
    for (let m = re.exec(it.str); m; m = re.exec(it.str)) {
      const raw = m[0];
      const text = normWord(raw);
      if (!text) continue;
      // Characters of leading/trailing punctuation to shave off the token's box,
      // matching what normWord dropped from `text`, so x/w span only the core.
      const lead = raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, "").length;
      const trail = raw.length - raw.replace(/[^\p{L}\p{N}]+$/u, "").length;
      const coreLen = raw.length - lead - trail;
      out.push({
        text,
        x: it.x + (m.index + lead) * charW,
        y: it.y,
        w: coreLen * charW,
        h: it.h,
      });
    }
  }
  return out;
}

/**
 * Each word's ordinal position within its visual PDF row (0-based, left-to-right),
 * parallel to `words` (so `out[p]` is the column index of `words[p]`). Rows are
 * formed by clustering on the vertical centre with a tolerance of ~0.6 of the
 * word height, so a single line of output groups together regardless of minor
 * baseline jitter. Used to disambiguate a repeated word by matching the clicked
 * word's source-line position against the PDF position.
 */
function rowIndices(words: WordBox[]): number[] {
  const col = new Array<number>(words.length).fill(0);
  // Visit words top-to-bottom (then left-to-right) so consecutive entries with a
  // close `y` form one row; flush a row when the next word drops far enough below.
  const order = words.map((_, i) => i).sort((a, b) => words[a].y - words[b].y || words[a].x - words[b].x);
  let members: number[] = [];
  let rowTop = -Infinity;
  const flush = () => {
    members.sort((a, b) => words[a].x - words[b].x);
    members.forEach((p, k) => (col[p] = k));
    members = [];
  };
  for (const p of order) {
    const tol = (words[p].h || 12) * 0.6;
    if (members.length && words[p].y - rowTop > tol) flush();
    if (!members.length) rowTop = words[p].y;
    members.push(p);
  }
  flush();
  return col;
}

/** Fallback when phrase matching finds nothing: locate `needle` as a substring of
 *  any run, nearest the target line. Handles words a token split would miss. */
function refineSingle(target: SyncRect, needle: string, items: TextItemBox[]): SyncRect | null {
  if (!needle) return null;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  let best: { rect: SyncRect; score: number } | null = null;
  for (const it of items) {
    if (!it.str || it.w <= 0) continue;
    const hay = it.str.toLowerCase();
    for (let idx = hay.indexOf(needle); idx >= 0; idx = hay.indexOf(needle, idx + needle.length)) {
      const charW = it.w / it.str.length;
      const x = it.x + idx * charW;
      const w = needle.length * charW;
      const cy = it.y + it.h / 2;
      const dy = Math.max(0, Math.abs(cy - tcy) - (target.h + it.h) / 2);
      const before = idx > 0 ? hay[idx - 1] : " ";
      const after = idx + needle.length < hay.length ? hay[idx + needle.length] : " ";
      const whole = !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
      const score = dy * 1e6 + Math.abs(x + w / 2 - tcx) + (whole ? 0 : 500);
      if (!best || score < best.score) best = { rect: { page: target.page, x, y: it.y, w, h: it.h }, score };
    }
  }
  return best ? best.rect : null;
}

/**
 * Narrow a SyncTeX forward-search box (`target`, typically a whole source line's
 * output) down to the exact word the caret sat on, using the surrounding
 * `phrase` for disambiguation. Tokenises the PDF page's `items` into positioned
 * words and, for each occurrence of the clicked word, counts how many of the
 * neighbouring phrase words also line up around it. Occurrences are ranked
 * lexicographically:
 *   1. the most matching phrase context (the strongest signal for WHICH
 *      occurrence the caret meant — and one a repeated word can't fake);
 *   2. then nearest the target row (`target` is the box {@link pickSyncRect}
 *      chose for the clicked column — only a tiebreak, because for a word that
 *      repeats on a source line that WRAPPED, that pick can land on the wrong
 *      visual row, so it must not override clear phrase context);
 *   3. then — when the phrase itself repeats — the occurrence whose position
 *      within its PDF row matches the clicked word's ordinal on the source line
 *      (`phrase.lineIndex`);
 *   4. and finally nearest the line centre horizontally.
 * Returns a tight box around the clicked word, or null (→ caller keeps the line
 * box). Pure / tested.
 */
export function refineToWord(
  target: SyncRect,
  phrase: CaretPhrase,
  items: TextItemBox[],
): SyncRect | null {
  const pw = phrase.words.map((w) => normWord(w));
  const ci = phrase.index;
  if (!pw.length || ci < 0 || ci >= pw.length || !pw[ci]) {
    return null;
  }
  const words = wordBoxes(items);
  const col = rowIndices(words);
  // The clicked word's ordinal on its source line; fall back to its index within
  // the (capped) phrase when a bare phrase carries no line position.
  const srcIndex = phrase.lineIndex ?? ci;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  // A candidate's ranking key, compared lexicographically (see the doc comment):
  // more matches wins; then the smaller row distance; then the smaller source-
  // line-position penalty; then the smaller horizontal distance. Sub-pixel `dy`
  // differences count as a tie so two words on the same visual row fall through
  // to the position/horizontal tiebreaks rather than splitting on jitter.
  interface Cand { rect: SyncRect; matches: number; dy: number; pos: number; xd: number; }
  const better = (a: Cand, b: Cand): boolean => {
    if (a.matches !== b.matches) return a.matches > b.matches;
    if (Math.abs(a.dy - b.dy) > 0.5) return a.dy < b.dy;
    if (a.pos !== b.pos) return a.pos < b.pos;
    return a.xd < b.xd;
  };
  let best: Cand | null = null;
  for (let p = 0; p < words.length; p++) {
    if (words[p].text !== pw[ci]) continue;
    // Count contiguous phrase words matching on each side of the clicked word.
    let matches = 1;
    for (let d = 1; ci - d >= 0 && p - d >= 0 && words[p - d].text === pw[ci - d]; d++) matches++;
    for (let d = 1; ci + d < pw.length && p + d < words.length && words[p + d].text === pw[ci + d]; d++) {
      matches++;
    }
    const wb = words[p];
    const cy = wb.y + wb.h / 2;
    const dy = Math.max(0, Math.abs(cy - tcy) - (target.h + wb.h) / 2);
    const pos = Math.min(Math.abs(col[p] - srcIndex), 900);
    const xd = Math.abs(wb.x + wb.w / 2 - tcx);
    const cand: Cand = {
      rect: { page: target.page, x: wb.x, y: wb.y, w: wb.w, h: wb.h },
      matches, dy, pos, xd,
    };
    if (!best || better(cand, best)) best = cand;
  }
  return best ? best.rect : refineSingle(target, pw[ci], items);
}

// --- Cross-file references (Ctrl/Cmd+Click to open) -------------------------
//
// LaTeX commands whose brace argument names another file the viewer can open in
// its own tab. The value is the extension assumed when the argument is written
// without one (LaTeX's own default for that command). `\includegraphics` has no
// default because graphics extensions are resolved against a search list we
// don't replicate, so a bare graphics argument is left unresolved.
const TEX_REF_COMMANDS: Record<string, string | null> = {
  input: ".tex",
  include: ".tex",
  subfile: ".tex",
  subfileinclude: ".tex",
  bibliography: ".bib",
  addbibresource: ".bib",
  includegraphics: null,
};

// `\cmd[opts]{arg}` for any of the file-referencing commands above. The optional
// bracket group (e.g. `\includegraphics[width=…]`) is skipped; the brace body is
// captured whole and split on commas later (e.g. `\bibliography{a,b}`).
const TEX_REF_RE = new RegExp(
  `\\\\(${Object.keys(TEX_REF_COMMANDS).join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
  "g",
);

/** A file reference recognised under the caret: the command (no backslash) and
 *  the single comma-separated path token the caret falls on. */
export interface TexRefTarget {
  command: string;
  token: string;
}

/**
 * Find the `\input`/`\include`/… reference the caret sits on, if any. A click
 * anywhere on the command (`\input{foo}`) counts as on the reference; when the
 * argument lists several comma-separated files the token under the caret wins,
 * falling back to the first.
 */
export function findTexRefAt(source: string, caret: number): TexRefTarget | null {
  TEX_REF_RE.lastIndex = 0;
  for (let m = TEX_REF_RE.exec(source); m; m = TEX_REF_RE.exec(source)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret < start || caret > end) continue;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const token = pickToken(m[2], caret - braceStart);
    if (!token) return null;
    return { command: m[1], token };
  }
  return null;
}

/** From a comma-separated brace body, return the trimmed token covering `offset`
 *  (relative to the body start), else the first non-empty token. */
function pickToken(body: string, offset: number): string {
  let pos = 0;
  let first = "";
  for (const part of body.split(",")) {
    const next = pos + part.length;
    const trimmed = part.trim();
    if (trimmed && !first) first = trimmed;
    if (offset >= pos && offset <= next && trimmed) return trimmed;
    pos = next + 1; // account for the comma
  }
  return first;
}

/** A character range `[start, end)` in the source covering a reference token's
 *  brace argument, used to decorate it as a clickable file link (#49). */
export interface TexRefRange {
  start: number;
  end: number;
}

/**
 * Every recognised `\input{…}`/`\includegraphics{…}`/… argument range in the
 * source, so the editor can underline them as clickable links (#49). Each
 * comma-separated token inside a brace body gets its own range. Pure (no FS
 * access) — it only finds the syntactic ranges; resolution still happens on
 * click via `resolveTexRefAsync`.
 */
export function texRefRanges(source: string): TexRefRange[] {
  const ranges: TexRefRange[] = [];
  TEX_REF_RE.lastIndex = 0;
  for (let m = TEX_REF_RE.exec(source); m; m = TEX_REF_RE.exec(source)) {
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const body = m[2];
    // One range per non-empty comma-separated token (trimmed to the token).
    let pos = 0;
    for (const part of body.split(",")) {
      const trimmedStart = part.length - part.trimStart().length;
      const trimmed = part.trim();
      if (trimmed) {
        const start = braceStart + pos + trimmedStart;
        ranges.push({ start, end: start + trimmed.length });
      }
      pos += part.length + 1; // account for the comma
    }
  }
  return ranges;
}

/** A resolved reference: the absolute path to open and the viewer to render it
 *  with, plus a tab label. */
export interface ResolvedTexRef {
  path: string;
  viewer: InternalViewer;
  label: string;
}

/**
 * Resolve a reference token against the referencing .tex file's path: apply the
 * command's default extension when the token has none, resolve it relative to
 * that file's directory, and pick the built-in viewer for the result. Returns
 * null when no extension can be assumed (a bare `\includegraphics`) or no viewer
 * handles the file type.
 */
export function resolveTexRef(
  currentPath: string,
  target: TexRefTarget,
  disabled?: ReadonlySet<InternalViewer>,
): ResolvedTexRef | null {
  const def = TEX_REF_COMMANDS[target.command] ?? null;
  const token = target.token.trim();
  if (!token) return null;

  const base = basename(token);
  const dot = base.lastIndexOf(".");
  const hasExt = dot > 0 && dot < base.length - 1;
  const rel = hasExt ? token : def == null ? null : token + def;
  if (rel == null) return null;

  const dir = dirname(currentPath);
  const abs = resolvePath(dir, rel);
  const name = basename(abs);
  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path: abs,
    is_dir: false,
    size: 0,
    extension,
    mime: null,
  };
  const viewer = internalViewerFor(entry, disabled);
  if (!viewer) return null;
  return { path: abs, viewer, label: name };
}

// Graphics extensions `\includegraphics` resolves a bare argument against, in
// the order it prefers them (PDF/vector first for engines that take them, then
// the common rasters). Used to pick a file when the argument omits the
// extension (the usual style) by listing the target directory.
const GRAPHICS_EXTS = [
  ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps",
  ".gif", ".webp", ".bmp", ".tif", ".tiff", ".svg",
];

/**
 * Resolve a reference, probing the filesystem when needed. Falls back to the
 * pure `resolveTexRef` for tokens whose path is fully determined; for a bare
 * `\includegraphics{…}` (no extension — the common case) it lists the target
 * directory and matches the stem against the graphics extensions in preference
 * order. Returns null when nothing matches or the directory can't be listed.
 */
export async function resolveTexRefAsync(
  currentPath: string,
  target: TexRefTarget,
  disabled?: ReadonlySet<InternalViewer>,
): Promise<ResolvedTexRef | null> {
  const direct = resolveTexRef(currentPath, target, disabled);
  if (direct) return direct;
  if (target.command !== "includegraphics") return null;

  const token = target.token.trim();
  if (!token) return null;
  // TeX reference tokens are written with forward slashes regardless of OS.
  const slash = token.lastIndexOf("/");
  const sub = slash >= 0 ? token.slice(0, slash) : "";
  const stem = (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
  if (!stem) return null;

  const dir = dirname(currentPath);
  const absDir = isAbsolute(token)
    ? normalizePath(sub || "/")
    : resolvePath(dir, sub);

  let entries: FileEntry[];
  try {
    entries = await invoke<FileEntry[]>("list_dir", { projectDir: absDir, relPath: "" });
  } catch {
    return null;
  }

  // Among files sharing the stem, take the one whose extension ranks earliest in
  // the graphics preference order; ignore non-graphics matches.
  let best: { entry: FileEntry; rank: number } | null = null;
  for (const e of entries) {
    if (e.is_dir) continue;
    const dot = e.name.lastIndexOf(".");
    if (dot <= 0 || e.name.slice(0, dot).toLowerCase() !== stem) continue;
    const rank = GRAPHICS_EXTS.indexOf(e.name.slice(dot).toLowerCase());
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { entry: e, rank };
  }
  if (!best) return null;
  const viewer = internalViewerFor(best.entry, disabled);
  if (!viewer) return null;
  return { path: best.entry.path, viewer, label: best.entry.name };
}

// --- \ref / \cite key autocomplete (#cite-ref-complete) ---------------------
//
// As the user types inside a reference-family command (`\ref{`, `\cref{`,
// `\autoref{`, `\eqref{`, …) or a cite-family command (`\cite{`, `\citep{`,
// `\parencite{`, …) the viewer offers a dropdown of candidate keys: `\label{…}`
// keys gathered from the document for refs, and entry keys from the connected
// `.bib` file(s) for cites. These helpers are pure (or invoke-only) so they can
// be unit-tested independently of the React editor.

/** Which kind of key a completion context expects. */
export type TexComplKind = "ref" | "cite";

/** A reference/cite command's open brace under the caret, plus the partial key
 *  token being typed (`query`) and the `[start, end)` source range to replace on
 *  accept. */
export interface TexComplContext {
  kind: TexComplKind;
  start: number;
  end: number;
  query: string;
}

/** Reference-family commands (cleveref/varioref/hyperref/base) that take a
 *  `\label` key as their brace argument. Matched case-insensitively, so `\Cref`
 *  and `\cref` both land here. */
const REF_COMPL_CMDS = new Set([
  "ref", "cref", "autoref", "eqref", "pageref", "vref", "vpageref", "nameref",
  "labelcref", "crefrange", "cpageref", "cpagerefrange", "fref", "fullref",
  "thref", "namecref", "nameCref",
]);

/** Classify the command preceding a brace: any command containing "cite" is a
 *  citation (covers natbib/biblatex variants — citep/citet/parencite/…), the
 *  fixed `REF_COMPL_CMDS` set is a reference. Returns null otherwise. */
function classifyComplCmd(cmd: string): TexComplKind | null {
  const lower = cmd.toLowerCase();
  if (lower.includes("cite")) return "cite";
  if (REF_COMPL_CMDS.has(lower)) return "ref";
  return null;
}

/**
 * Detect whether `caret` sits inside the (possibly still-unclosed) brace
 * argument of a reference- or cite-family command, for live autocomplete. Scans
 * a short window back from the caret for the enclosing `{` — bailing on a `}` or
 * a blank line first — then checks the text just before it for `\cmd` (allowing
 * a `*` and any number of `[optional]` groups, e.g. `\citep[see][p.5]{`). The
 * `query` is the comma-separated token under the caret, trimmed; `start`/`end`
 * cover that token so accepting replaces just it (keeping earlier keys in a
 * multi-key `\cite{a,b}`). Returns null when not in such a context.
 */
export function findTexComplAt(source: string, caret: number): TexComplContext | null {
  if (caret < 0 || caret > source.length) return null;
  let braceStart = -1;
  const limit = Math.max(0, caret - 600);
  for (let i = caret - 1; i >= limit; i--) {
    const c = source[i];
    if (c === "}") return null;
    if (c === "{") { braceStart = i; break; }
    if (c === "\n" && source[i - 1] === "\n") return null;
  }
  if (braceStart < 0) return null;
  const tail = source.slice(Math.max(0, braceStart - 80), braceStart);
  const m = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*$/.exec(tail);
  if (!m) return null;
  const kind = classifyComplCmd(m[1]);
  if (!kind) return null;
  const bodyStart = braceStart + 1;
  const segment = source.slice(bodyStart, caret);
  if (/[{}]/.test(segment)) return null; // brace appeared since the open → not in the arg
  const comma = segment.lastIndexOf(",");
  const rawStart = comma >= 0 ? comma + 1 : 0;
  const raw = segment.slice(rawStart);
  const lead = raw.length - raw.trimStart().length;
  return {
    kind,
    start: bodyStart + rawStart + lead,
    end: caret,
    query: raw.trim(),
  };
}

/** Every `\label{…}` key in a TeX source, in document order (duplicates kept;
 *  the caller dedupes when merging across files). */
export function parseTexLabels(source: string): string[] {
  const out: string[] = [];
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const k = m[1].trim();
    if (k) out.push(k);
  }
  return out;
}

/** A parsed `.bib` entry: the citation key plus a few display fields. */
export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
}

/** Pull a single field value out of a bib entry body, handling `{…}` (brace-
 *  balanced), `"…"`, and bare/number values. Strips braces and collapses
 *  whitespace for display. */
function bibField(body: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*`, "i").exec(body);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  const open = body[i];
  let val = "";
  if (open === "{") {
    let depth = 0;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "{") { depth++; if (depth === 1) continue; }
      else if (ch === "}") { depth--; if (depth === 0) break; }
      val += ch;
    }
  } else if (open === '"') {
    for (i++; i < body.length && body[i] !== '"'; i++) val += body[i];
  } else {
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "," || ch === "\n") break;
      val += ch;
    }
  }
  const cleaned = val.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

/**
 * Parse a `.bib` file into its entries. Tolerant rather than strict: it finds
 * each `@type{key,` header, skips `@comment/@preamble/@string`, brace-matches to
 * the entry's end, and extracts title/author/year for the dropdown's display.
 * Not a full BibTeX parser — good enough to list keys and a label.
 */
export function parseBibEntries(bib: string): BibEntry[] {
  const out: BibEntry[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g;
  for (let m = re.exec(bib); m; m = re.exec(bib)) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string") continue;
    const key = m[2].trim();
    if (!key) continue;
    const braceOpen = bib.indexOf("{", m.index);
    let depth = 0;
    let end = bib.length;
    for (let i = braceOpen; i < bib.length; i++) {
      const c = bib[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = bib.slice(braceOpen + 1, end);
    out.push({
      key, type,
      title: bibField(body, "title"),
      author: bibField(body, "author"),
      year: bibField(body, "year"),
    });
    re.lastIndex = end; // resume past this entry so nested @ in a field is ignored
  }
  return out;
}

/** Brace tokens (comma-split, trimmed) of the given commands in `source`. Used
 *  to follow `\input`/`\include` and locate `\bibliography`/`\addbibresource`. */
function texCommandTokens(source: string, commands: string[]): string[] {
  const re = new RegExp(
    `\\\\(?:${commands.join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
    "g",
  );
  const out: string[] = [];
  for (let m = re.exec(source); m; m = re.exec(source)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Resolve a `\input`/`\bibliography` token to an absolute path against the
 *  referencing file's dir, appending `defExt` when it has none. */
function resolveSibling(fromFile: string, token: string, defExt: string): string {
  const base = basename(token);
  const hasExt = base.includes(".");
  const rel = hasExt ? token : token + defExt;
  const dir = dirname(fromFile) || "/";
  return resolvePath(dir, rel);
}

const TEX_INPUT_CMDS = ["input", "include", "subfile", "subfileinclude"];
const TEX_BIB_CMDS = ["bibliography", "addbibresource"];

/** Candidate keys for the ref/cite dropdown: `\label` keys across the document
 *  and bib entries from the connected `.bib` file(s). */
export interface TexCompletions {
  labels: string[];
  cites: BibEntry[];
}

/**
 * Gather completion candidates for `currentPath`'s document. Resolves the build
 * root, walks `\input`/`\include` to collect every reachable `.tex` file
 * (bounded), unions their `\label` keys, and reads every `.bib` referenced via
 * `\bibliography`/`\addbibresource` for its entry keys. All file reads are
 * best-effort: a missing/unreadable file is skipped. Pure parsing is delegated
 * to the tested helpers above.
 */
export async function gatherTexCompletions(
  currentPath: string,
  projectId: string | null = null,
): Promise<TexCompletions> {
  const root = await resolveTexRoot(currentPath);
  const seenTex = new Set<string>();
  const queue = [root, currentPath];
  const labels: string[] = [];
  const bibPaths = new Set<string>();

  while (queue.length && seenTex.size < 60) {
    const file = queue.shift()!;
    if (seenTex.has(file)) continue;
    seenTex.add(file);
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: file, projectId });
    } catch {
      continue;
    }
    for (const l of parseTexLabels(text)) labels.push(l);
    for (const t of texCommandTokens(text, TEX_INPUT_CMDS)) {
      queue.push(resolveSibling(file, t, ".tex"));
    }
    for (const t of texCommandTokens(text, TEX_BIB_CMDS)) {
      bibPaths.add(resolveSibling(file, t, ".bib"));
    }
  }

  const cites: BibEntry[] = [];
  const seenKey = new Set<string>();
  for (const bib of bibPaths) {
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: bib, projectId });
    } catch {
      continue;
    }
    for (const e of parseBibEntries(text)) {
      if (seenKey.has(e.key)) continue;
      seenKey.add(e.key);
      cites.push(e);
    }
  }

  return { labels: Array.from(new Set(labels)), cites };
}
