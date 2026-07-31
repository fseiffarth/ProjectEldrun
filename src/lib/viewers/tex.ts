import { invoke } from "@tauri-apps/api/core";
import { internalViewerFor, type FileEntry, type InternalViewer } from "./fileUtils";
import { bibPlainValue, parseBib } from "./bib";
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

/** Drop the cached probe and re-query the backend. The one-shot cache above is
 *  right for a probe that never changes mid-session, but it goes stale the
 *  moment the user installs a TeX distribution from the "no engine found"
 *  banner — call this after that install (or from a manual "Recheck") so the
 *  viewer picks up the newly-detected engine without an app restart. */
export function refreshTexCapability(): Promise<TexCapability> {
  texCapPromise = null;
  return getTexCapability();
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
 *  constituent boxes / wrapped rows). Resolves to `[]` when the query *ran* but
 *  matched nothing, and to `null` when the backend command itself errored — i.e.
 *  SyncTeX could not run at all (the `synctex` tool absent, or a backend not yet
 *  rebuilt for it). Keeping the two apart is what lets the caller tell an honest
 *  "no match on that line" from "jump-to-cursor is unavailable" (they used to
 *  read identically as a miss). */
export function synctexView(
  pdf: string,
  input: string,
  line: number,
  column: number,
): Promise<SyncRect[] | null> {
  return invoke<SyncRect[]>("synctex_view", { pdf, input, line, column }).catch(() => null);
}

/**
 * SyncTeX forward search is sensitive to how the source path is spelled — it
 * matches the `-i` input against the path string recorded at compile time, which
 * may be the absolute path, the name relative to the compile dir, or a bare
 * basename depending on the engine/version and how the file was passed in. Eldrun
 * compiles with the bare filename, so an absolute `-i` often fails to match. This
 * tries the absolute path, the path relative to the build dir, and the basename
 * (deduped, in that order) and returns the first spelling that yields records —
 * so forward search works regardless of which spelling SyncTeX stored.
 *
 * Propagates {@link synctexView}'s two failure modes so the caller can tell them
 * apart: `[]` when SyncTeX ran but no spelling matched (a genuine miss), `null`
 * when *every* attempt errored — i.e. SyncTeX could not run at all (unavailable).
 * A single spelling that runs (even to an empty result) counts as "ran", so a
 * mismatched spelling never masquerades as unavailable.
 */
export async function synctexViewBest(
  pdf: string,
  input: string,
  rootDir: string,
  line: number,
  column: number,
): Promise<SyncRect[] | null> {
  let ran = false;
  for (const cand of forwardInputCandidates(input, rootDir)) {
    const recs = await synctexView(pdf, cand, line, column);
    if (recs === null) continue; // this attempt errored — the next spelling may run
    ran = true;
    if (recs.length) return recs; // first spelling that matched wins
  }
  return ran ? [] : null;
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

// --- Math/environment delimiter matching (bracket-match, LaTeX extras) ------
//
// The editor's plain ()[]{} matcher (`FileViewerPane.findMatchingBracket`)
// covers group braces and optional-arg brackets, but LaTeX has three more
// delimiter families worth the same "highlight the matching one" affordance:
// math-mode toggles (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) and `\begin{env}…
// \end{env}` structure blocks. Kept here rather than in FileViewerPane
// because they're LaTeX syntax, not generic code-editor behaviour — the
// caller only tries these when the open file's language is "tex".
//
// `TexDelimiterMatch` is structurally identical to FileViewerPane's
// `BracketMatch` ({open,close} ranges) on purpose, so `decorateBracketMatch`
// can render either without either module importing the other's type
// (importing FileViewerPane's type back into this module, which
// FileViewerPane already imports from, would be a cycle).

/** One side of a matched delimiter: a `[start, end)` source range — mirrors
 *  FileViewerPane's `BracketSide`. */
export interface TexDelimiterSide {
  start: number;
  end: number;
}

/** A matched math/environment delimiter pair — mirrors FileViewerPane's
 *  `BracketMatch` (see the section comment above for why it's a separate,
 *  structurally-identical type rather than an import). */
export interface TexDelimiterMatch {
  open: TexDelimiterSide;
  close: TexDelimiterSide;
}

/** Builds a clean `{start,end}`-only pair from whatever token objects the two
 *  scanners pass in (both carry an extra `kind` field the caller has no use
 *  for once matched) — stripped explicitly rather than relying on TS's
 *  structural typing to hide it, since excess properties on a plain object
 *  survive at runtime regardless of what the parameter type says. */
function texDelimiterPair(open: TexDelimiterSide, close: TexDelimiterSide): TexDelimiterMatch {
  return {
    open: { start: open.start, end: open.end },
    close: { start: close.start, end: close.end },
  };
}

/**
 * How closely `caret` "touches" `side` — the same test the plain bracket
 * matcher applies to a single character, generalised to a multi-character
 * token (`\[`, `$$`, a whole `\begin{itemize}`): anywhere in the token counts,
 * not just its two ends. Returns a rank rather than a boolean so a caller
 * choosing among several candidate tokens can prefer the closer touch —
 * `0` (caret sits right before the token, at its `start`) beats `1` (right
 * after, at its `end`) beats `2` (strictly inside it); `null` when caret
 * doesn't touch it at all. The rank matters when two tokens are directly
 * adjacent with nothing between them (`\end{a}\begin{b}`): the boundary caret
 * sits at BOTH `\end{a}`'s `end` and `\begin{b}`'s `start`, and rank prefers
 * `\begin{b}` — the same "check the token starting right at the caret before
 * the one ending there" priority `FileViewerPane.findMatchingBracket` uses
 * for `()[]{}`. */
function touchRank(side: TexDelimiterSide, caret: number): number | null {
  if (side.start === caret) return 0;
  if (side.end === caret) return 1;
  if (caret > side.start && caret < side.end) return 2;
  return null;
}

/** One recognised math-delimiter token in source order. `$$` is matched
 *  before a lone `$` (checked first in the scanner below) so display math
 *  isn't split into two bogus inline-math tokens. */
interface MathToken {
  kind: "dollar" | "ddollar" | "pOpen" | "pClose" | "bOpen" | "bClose";
  start: number;
  end: number;
}

/** True when the run of backslashes immediately before `pos` has odd length —
 *  i.e. the character AT `pos` is itself escaped (`\$` is a literal dollar
 *  sign, not a math toggle; `\\$` is a literal backslash followed by a real
 *  toggle, so it is NOT escaped). The standard TeX parity rule. */
function isBackslashEscaped(text: string, pos: number): boolean {
  let n = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/**
 * Blank every TeX line comment — an unescaped `%` to the end of its line — with
 * spaces, leaving the string the SAME length (offsets, and every `\n`, are
 * preserved) so a caller can keep scanning it with the module's offset-based
 * regexes and still map a match back onto the real source. This is what makes the
 * structure sidebar and the editor's link layer ignore a commented-out
 * `\input{…}`/`\includegraphics{…}` rather than list it, underline it or follow it
 * on Ctrl+click. `\%` (an escaped literal percent) is not a comment. Deliberately
 * shallow like the rest of this module — it does not skip `verbatim`/`\verb` bodies
 * (a `%` there is treated as a comment), which at worst hides a reference nested
 * inside verbatim, never a real one. Pure.
 */
export function blankTexComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "%" && !isBackslashEscaped(source, i)) {
      // Blank from here to (not including) the next newline.
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Every math-delimiter token in `text`, in source order: `$`/`$$` (skipping an
 * escaped `\$`) and the literal 2-character sequences `\(`/`\)`/`\[`/`\]`. Not
 * TeX-verbatim/comment-aware (a `%` comment or a verbatim block can contain a
 * bare `$` that isn't really math) — the same "plain scan, no deep parsing"
 * level the rest of this module's regex-based helpers work at. Pure.
 */
function texMathTokens(text: string): MathToken[] {
  const out: MathToken[] = [];
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "\\(") { out.push({ kind: "pOpen", start: i, end: i + 2 }); i++; continue; }
    if (two === "\\)") { out.push({ kind: "pClose", start: i, end: i + 2 }); i++; continue; }
    if (two === "\\[") { out.push({ kind: "bOpen", start: i, end: i + 2 }); i++; continue; }
    if (two === "\\]") { out.push({ kind: "bClose", start: i, end: i + 2 }); i++; continue; }
    if (text[i] === "$") {
      if (isBackslashEscaped(text, i)) continue;
      if (text[i + 1] === "$") { out.push({ kind: "ddollar", start: i, end: i + 2 }); i++; continue; }
      out.push({ kind: "dollar", start: i, end: i + 1 });
    }
  }
  return out;
}

/**
 * Pair up a token stream from {@link texMathTokens}: `\(`/`\)` and `\[`/`\]`
 * nest like ordinary brackets (a stack per kind), while `$` and `$$` are the
 * SAME token on both sides, so they pair by toggling (first one open, next one
 * of the same kind closes it) rather than by a stack. An unmatched opener
 * (odd count, or a `\)`/`\]` with nothing open) is simply dropped, matching
 * this codebase's other bracket matchers' "unbalanced source → no match"
 * behaviour. Pure.
 */
function pairTexMathTokens(tokens: MathToken[]): TexDelimiterMatch[] {
  const pairs: TexDelimiterMatch[] = [];
  const parenStack: MathToken[] = [];
  const bracketStack: MathToken[] = [];
  let openDollar: MathToken | null = null;
  let openDDollar: MathToken | null = null;
  for (const tok of tokens) {
    switch (tok.kind) {
      case "pOpen":
        parenStack.push(tok);
        break;
      case "pClose": {
        const open = parenStack.pop();
        if (open) pairs.push(texDelimiterPair(open, tok));
        break;
      }
      case "bOpen":
        bracketStack.push(tok);
        break;
      case "bClose": {
        const open = bracketStack.pop();
        if (open) pairs.push(texDelimiterPair(open, tok));
        break;
      }
      case "ddollar":
        if (openDDollar) {
          pairs.push(texDelimiterPair(openDDollar, tok));
          openDDollar = null;
        } else {
          openDDollar = tok;
        }
        break;
      case "dollar":
        if (openDollar) {
          pairs.push(texDelimiterPair(openDollar, tok));
          openDollar = null;
        } else {
          openDollar = tok;
        }
        break;
    }
  }
  return pairs;
}

/**
 * The math-delimiter pair (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) the caret is
 * touching, if any — for the bracket-match overlay's LaTeX extras. `null` when
 * the caret touches none, or touches an unmatched one. Pure / unit-tested.
 */
export function findTexMathDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  const pairs = pairTexMathTokens(texMathTokens(text));
  let best: TexDelimiterMatch | null = null;
  let bestRank = Infinity;
  for (const p of pairs) {
    for (const side of [p.open, p.close]) {
      const rank = touchRank(side, caret);
      if (rank != null && rank < bestRank) {
        bestRank = rank;
        best = p;
      }
    }
  }
  return best;
}

/** Every `\begin{name}`/`\end{name}` occurrence, whole-token ranges (the
 *  environment name is not captured — matching ignores it, see
 *  {@link findTexEnvDelimiterMatch}). */
const TEX_ENV_TOKEN_RE = /\\(begin|end)\s*\{[^{}]*\}/g;

interface EnvToken {
  kind: "begin" | "end";
  start: number;
  end: number;
}

function texEnvTokens(text: string): EnvToken[] {
  const out: EnvToken[] = [];
  TEX_ENV_TOKEN_RE.lastIndex = 0;
  for (let m = TEX_ENV_TOKEN_RE.exec(text); m; m = TEX_ENV_TOKEN_RE.exec(text)) {
    out.push({ kind: m[1] === "begin" ? "begin" : "end", start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The `\begin{…}`/`\end{…}` pair straddling `caret`, if any — the "begin/end
 * structure" counterpart of bracket-match, for `\begin{itemize}…\end{itemize}`
 * blocks. Matching is by NESTING DEPTH ONLY, deliberately ignoring the
 * environment name: a well-formed LaTeX document's environments always nest
 * properly regardless of name (you cannot legally open `itemize` inside
 * `enumerate` and close them out of order), so a name-agnostic depth count
 * finds the right partner for any well-formed document — the same "plain
 * nesting count" `FileViewerPane`'s ()[]{} matcher uses, just applied to a
 * multi-character token instead of a single character. Returns `null` when
 * the caret touches neither a `\begin`/`\end`, or the one it touches has no
 * partner (unbalanced source). Pure / unit-tested.
 */
export function findTexEnvDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  const tokens = texEnvTokens(text);
  let idx = -1;
  let bestRank = Infinity;
  for (let i = 0; i < tokens.length; i++) {
    const rank = touchRank(tokens[i], caret);
    if (rank != null && rank < bestRank) {
      bestRank = rank;
      idx = i;
    }
  }
  if (idx < 0) return null;
  const tok = tokens[idx];
  if (tok.kind === "begin") {
    let depth = 1;
    for (let i = idx + 1; i < tokens.length; i++) {
      if (tokens[i].kind === "begin") depth++;
      else {
        depth--;
        if (depth === 0) return texDelimiterPair(tok, tokens[i]);
      }
    }
  } else {
    let depth = 1;
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i].kind === "end") depth++;
      else {
        depth--;
        if (depth === 0) return texDelimiterPair(tokens[i], tok);
      }
    }
  }
  return null;
}

/**
 * The bracket-match overlay's full LaTeX extras: math delimiters first (the
 * more common case), falling back to `\begin`/`\end`. The caller
 * (`FileViewerPane`'s `CodeEditor`) tries this only after its own plain
 * ()[]{} matcher comes up empty, and only for a `.tex` file. Pure.
 */
export function findTexDelimiterMatch(text: string, caret: number): TexDelimiterMatch | null {
  return findTexMathDelimiterMatch(text, caret) ?? findTexEnvDelimiterMatch(text, caret);
}

/** A whole `\begin{…}`/`\end{…}` token with its environment name located inside
 *  it — `{start,end}` is the token, `[nameStart,nameEnd)` the name between the
 *  braces (empty for `\begin{}`, which is what a half-typed one looks like). */
interface EnvNameToken {
  kind: "begin" | "end";
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
}

/** `\begin{env}`/`\end{env}` with the name captured — the same token shape
 *  {@link TEX_ENV_TOKEN_RE} matches, split so the name can be addressed. */
const TEX_ENV_NAME_RE = /\\(begin|end)(\s*)\{([^{}]*)\}/g;

function texEnvNameTokens(text: string): EnvNameToken[] {
  const out: EnvNameToken[] = [];
  TEX_ENV_NAME_RE.lastIndex = 0;
  for (let m = TEX_ENV_NAME_RE.exec(text); m; m = TEX_ENV_NAME_RE.exec(text)) {
    const nameStart = m.index + 1 + m[1].length + m[2].length + 1; // `\` + kw + ws + `{`
    out.push({
      kind: m[1] === "begin" ? "begin" : "end",
      start: m.index,
      end: m.index + m[0].length,
      nameStart,
      nameEnd: nameStart + m[3].length,
    });
  }
  return out;
}

/**
 * The environment name's range when `caret` sits between the braces of a
 * `\begin{…}`/`\end{…}` — for the editor's "click into the braces, get the name
 * selected" gesture, so retyping an environment is one gesture rather than a
 * drag across a word the double-click rules split at `:` and `*` anyway.
 * Inclusive at both ends (clicking just after `{` or just before `}` counts);
 * `null` anywhere else, and a zero-length range for an empty `\begin{}`, which a
 * caller may treat as nothing to select. Pure / unit-tested.
 */
export function texEnvNameRangeAt(text: string, caret: number): TexDelimiterSide | null {
  for (const t of texEnvNameTokens(text)) {
    if (caret >= t.nameStart && caret <= t.nameEnd) return { start: t.nameStart, end: t.nameEnd };
  }
  return null;
}

/**
 * The two environment NAMES of a `\begin{…}…\end{…}` pair, as a delimiter match,
 * when `caret` sits inside either of them — so the bracket-match overlay marks
 * the partner's name while you are in one, which is what says *which* `\end` a
 * rename is about to carry with it. The whole-token match
 * ({@link findTexEnvDelimiterMatch}) still answers a caret on the `\begin`
 * keyword itself; this is the finer reading inside the braces.
 *
 * Deliberately does NOT require the two names to agree: mid-rename they don't,
 * and that is exactly when the marker earns its place. Pairing is the same
 * name-agnostic depth count everything else here uses. A name that is currently
 * empty (`\begin{}`) yields a zero-length side — nothing to paint on that end,
 * while the partner is still marked. Pure / unit-tested.
 */
export function findTexEnvNameMatch(text: string, caret: number): TexDelimiterMatch | null {
  const tokens = texEnvNameTokens(text);
  const here = tokens.find((t) => caret >= t.nameStart && caret <= t.nameEnd);
  if (!here) return null;
  const pair = findTexEnvDelimiterMatch(text, here.start);
  if (!pair) return null;
  const partnerSide = here.kind === "begin" ? pair.close : pair.open;
  const partner = tokens.find((t) => t.start === partnerSide.start);
  if (!partner || partner.start === here.start) return null;
  const name = (t: EnvNameToken) => ({ start: t.nameStart, end: t.nameEnd });
  return here.kind === "begin"
    ? { open: name(here), close: name(partner) }
    : { open: name(partner), close: name(here) };
}

/** The single changed run between two versions of a document — the common
 *  prefix/suffix pared off, so `[start, prevEnd)` in `prev` was replaced by
 *  `[start, nextEnd)` in `next`. `null` when nothing changed. A multi-caret or
 *  find-and-replace edit collapses to one wide run here, which is exactly what
 *  the caller wants: a run wider than the environment name is not a rename. */
function texEditSpan(
  prev: string,
  next: string,
): { start: number; prevEnd: number; nextEnd: number } | null {
  if (prev === next) return null;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let tail = 0;
  while (
    tail < prev.length - start &&
    tail < next.length - start &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start, prevEnd: prev.length - tail, nextEnd: next.length - tail };
}

/** The result of mirroring an environment rename: the document with BOTH names
 *  changed, and where the caret belongs in it (mirroring into a `\begin` that
 *  sits before the caret shifts everything after it). */
export interface TexEnvRename {
  text: string;
  caret: number;
}

/**
 * Keep `\begin{env}` and `\end{env}` spelled the same while one of them is being
 * edited: given the draft before (`prev`) and after (`next`) a keystroke, plus
 * the caret in `next`, return `next` with the PARTNER's name changed the same
 * way. `null` — the ordinary case — means the edit was not an environment
 * rename and the caller should take `next` as it stands.
 *
 * Three conditions, each of which exists to stop this from rewriting text the
 * user did not aim at:
 *
 *  - the whole changed run lies inside one environment name's braces, and the
 *    caret is in there too (a paste spanning the braces, or a find-and-replace
 *    across the file, widens the run past the name and is left alone);
 *  - the token has a partner at all, by the same name-agnostic depth count
 *    {@link findTexEnvDelimiterMatch} uses — a `\begin` still waiting for its
 *    `\end` has nothing to keep in step;
 *  - the partner still spells the name the edited token spelled BEFORE the
 *    keystroke. A pair that already disagreed is not a pair somebody is
 *    renaming, and depth-matching an unbalanced document can pick the wrong
 *    partner — this is what keeps such a mistake from being written into it.
 *
 * Pure / unit-tested.
 */
export function syncTexEnvRename(prev: string, next: string, caret: number): TexEnvRename | null {
  const span = texEditSpan(prev, next);
  if (!span) return null;
  const delta = next.length - prev.length;

  const tokens = texEnvNameTokens(next);
  const edited = tokens.find(
    (t) =>
      span.start >= t.nameStart &&
      span.nextEnd <= t.nameEnd &&
      caret >= t.nameStart &&
      caret <= t.nameEnd,
  );
  if (!edited) return null;

  // The token's own text before the edit: its start is inside the untouched
  // prefix, so only its end moved — by exactly the length the document did.
  const oldName = prev.slice(edited.nameStart, edited.nameEnd - delta);
  const newName = next.slice(edited.nameStart, edited.nameEnd);
  if (oldName === newName) return null;

  const pair = findTexEnvDelimiterMatch(next, edited.start);
  if (!pair) return null;
  const partnerSide = edited.kind === "begin" ? pair.close : pair.open;
  if (partnerSide.start === edited.start) return null;
  const partner = tokens.find((t) => t.start === partnerSide.start);
  if (!partner) return null;
  if (next.slice(partner.nameStart, partner.nameEnd) !== oldName) return null;

  const text =
    next.slice(0, partner.nameStart) + newName + next.slice(partner.nameEnd);
  const shift = partner.nameStart < caret ? newName.length - oldName.length : 0;
  return { text, caret: caret + shift };
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
  // Scan with comments blanked (same length, so `caret` and every offset still
  // line up) — a commented-out `\input{…}` is not a link to follow.
  source = blankTexComments(source);
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
  // Blanking comments keeps every offset stable (so the emitted ranges still
  // index the real source) while dropping a commented-out `\input{…}` from the
  // underlined-link set.
  source = blankTexComments(source);
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
  return viewerRefFor(resolvePath(dir, rel), disabled);
}

/** An absolute path as something openable: the viewer that renders it plus the
 *  tab label. Null when no built-in viewer handles the type. Shared by the file
 *  references above and the `\ref`/`\cite` jump below, so a target opens the
 *  same way however it was named. */
function viewerRefFor(
  path: string,
  disabled?: ReadonlySet<InternalViewer>,
): ResolvedTexRef | null {
  const name = basename(path);
  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot).toLowerCase() : null;
  const entry: FileEntry = {
    name,
    path,
    is_dir: false,
    size: 0,
    extension,
    mime: null,
  };
  const viewer = internalViewerFor(entry, disabled);
  if (!viewer) return null;
  return { path, viewer, label: name };
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

/** A `\label{…}` key plus the title of the sectioning command it falls under,
 *  when one precedes it in the same file — the `\ref`/`\cref` dropdown's "which
 *  section is this in" detail. */
export interface TexLabelEntry {
  key: string;
  section?: string;
}

/** Sectioning commands (article/report/book classes) whose title is read for
 *  a label's `section`. Matched with an optional trailing `*` (unnumbered
 *  variants) and an optional `[short title]`, which is skipped in favour of
 *  the full `{…}` title. */
const SECTIONING_CMDS = ["part", "chapter", "section", "subsection", "subsubsection"];

/**
 * Index of the brace matching the one at `open` (a backslash-escaped `{`/`}`
 * does not count), or `text.length` when unterminated.
 */
function matchTexBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Compact, human-readable form of a section title: inline-formatting
 *  commands (`\textbf{…}`, `\emph{…}`, accents, …) and braces dropped,
 *  whitespace collapsed. Best-effort, like {@link bibPlainValue} — a display
 *  string, never round-tripped. */
function texPlainTitle(value: string): string {
  return value
    .replace(/\\[a-zA-Z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every sectioning command's position and title, in document order —
 *  `parseTexLabelEntries`'s lookup table for "which section is this label
 *  in". A title is brace-matched, so `\section{Results for \texttt{foo}}`
 *  reads its whole title rather than stopping at the nested brace. */
export function parseTexSections(source: string): Array<{ pos: number; title: string }> {
  const out: Array<{ pos: number; title: string }> = [];
  const re = new RegExp(`\\\\(?:${SECTIONING_CMDS.join("|")})\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const open = m.index + m[0].length - 1;
    const close = matchTexBrace(source, open);
    const title = texPlainTitle(source.slice(open + 1, close));
    if (title) out.push({ pos: m.index, title });
  }
  return out;
}

/** Every `\label{…}` key in a TeX source, each with the title of the nearest
 *  preceding sectioning command (if any), in document order (duplicates
 *  kept; the caller dedupes when merging across files). */
export function parseTexLabels(source: string): TexLabelEntry[] {
  const sections = parseTexSections(source);
  let secIdx = 0;
  const out: TexLabelEntry[] = [];
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const k = m[1].trim();
    if (!k) continue;
    while (secIdx + 1 < sections.length && sections[secIdx + 1].pos < m.index) secIdx++;
    const section =
      sections.length && sections[secIdx].pos < m.index ? sections[secIdx].title : undefined;
    out.push({ key: k, section });
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

/**
 * The `.bib` entries of a bibliography, for the `\cite` dropdown: the citation
 * key plus the three fields it displays.
 *
 * A thin adapter over `lib/viewers/bib`'s parser rather than a second reading of
 * the format — the bibliography card view and this dropdown must not be able to
 * disagree about what is in a `.bib` (which entries exist, what a field's value
 * is), and the parser that has to survive being *edited* through is the stricter
 * of the two. `@string`/`@preamble`/`@comment` carry no citation key, so they
 * drop out here.
 */
export function parseBibEntries(bib: string): BibEntry[] {
  return parseBib(bib)
    .records.filter((r) => r.kind === "entry" && r.key)
    .map((r) => {
      const field = (name: string): string | undefined => {
        const hit = r.fields.find((f) => f.key === name);
        const value = hit ? bibPlainValue(hit.value) : "";
        return value || undefined;
      };
      return {
        key: r.key,
        type: r.type,
        title: field("title"),
        author: field("author"),
        year: field("year"),
      };
    });
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
  labels: TexLabelEntry[];
  cites: BibEntry[];
}

/**
 * **The** walk of a document's `.tex` files, and the one place that walk is
 * defined: resolve the build root, follow `\input`/`\include`/`\subfile` from
 * there, hand each file's text to `visit`, and collect every `.bib` the document
 * names on the way. Bounded at 60 files and best-effort throughout — a missing or
 * unreadable file is skipped rather than thrown over, because this runs behind a
 * click that has to answer either way.
 *
 * Two callers share it and must not drift apart: the ref/cite **completion** list
 * (what keys exist) and the ref/cite **jump** (where one is defined). A dropdown
 * offering a key the click cannot then reach is the failure a second copy of this
 * walk would eventually produce.
 *
 * `visit` returning true ends the walk — a definition search is done the moment it
 * has found the definition, whereas gathering candidates reads everything.
 */
async function walkTexSources(
  currentPath: string,
  projectId: string | null,
  visit: (file: string, text: string) => boolean | void,
  options: { currentFirst?: boolean; currentText?: string } = {},
): Promise<Set<string>> {
  const root = await resolveTexRoot(currentPath);
  const seenTex = new Set<string>();
  const queue = options.currentFirst ? [currentPath, root] : [root, currentPath];
  const bibPaths = new Set<string>();

  while (queue.length && seenTex.size < 60) {
    const file = queue.shift()!;
    if (seenTex.has(file)) continue;
    seenTex.add(file);
    let text: string;
    // The file being edited is read from the caller's DRAFT when it offers one:
    // a `\label` typed a minute ago is not on disk yet, and a jump that cannot
    // find the label you are looking at reads as a broken feature.
    if (options.currentText != null && file === currentPath) {
      text = options.currentText;
    } else {
      try {
        text = await invoke<string>("read_file_text", { path: file, projectId });
      } catch {
        continue;
      }
    }
    for (const t of texCommandTokens(text, TEX_INPUT_CMDS)) {
      queue.push(resolveSibling(file, t, ".tex"));
    }
    for (const t of texCommandTokens(text, TEX_BIB_CMDS)) {
      bibPaths.add(resolveSibling(file, t, ".bib"));
    }
    if (visit(file, text) === true) break;
  }
  return bibPaths;
}

/**
 * Gather completion candidates for `currentPath`'s document: every reachable
 * `.tex` file's `\label` keys, plus the entry keys of every `.bib` the document
 * references. The walk and its bounds are {@link walkTexSources}'; pure parsing is
 * the tested helpers'.
 */
export async function gatherTexCompletions(
  currentPath: string,
  projectId: string | null = null,
): Promise<TexCompletions> {
  const labels: TexLabelEntry[] = [];
  const seenLabel = new Set<string>();
  const bibPaths = await walkTexSources(currentPath, projectId, (_file, text) => {
    for (const l of parseTexLabels(text)) {
      if (seenLabel.has(l.key)) continue;
      seenLabel.add(l.key);
      labels.push(l);
    }
  });

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

  return { labels, cites };
}

// --- \ref / \cite jump-to-definition (#tex-ref-jump) ------------------------
//
// The other half of the cross-reference. `\input{…}` has been Ctrl-clickable
// since #49 and `\ref{`/`\cite{` have offered a key dropdown since
// #cite-ref-complete, which between them left the one question a reader actually
// asks — "what IS equation (3), what IS [12]?" — as the only one the editor could
// not answer: the key was typed here and defined somewhere in a 40-file document.
//
// A key reference is not a file reference and resolves nothing like one: the
// target is a POSITION, found by searching the document's own sources for the
// `\label{…}` (or the `.bib` record) that defines the key, and reached through the
// existing editor-jump channel rather than by opening anything new when the
// definition is in the file already on screen.

/** A `\ref`/`\cite`-family key under the caret: which family, and the single
 *  comma-separated key the caret falls on (`\cite{a,b}` picks one). */
export interface TexKeyRef {
  kind: TexComplKind;
  key: string;
}

/** Any `\command[opt]{body}` whose body holds no braces — the shape every
 *  reference and citation command takes. The command is classified afterwards
 *  (`classifyComplCmd`), so this stays one regex rather than one per family, and
 *  `\textbf{\ref{x}}` matches the inner command because the outer body has
 *  braces in it. */
const TEX_KEYREF_RE = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g;

/**
 * The `\ref`/`\cite` key the caret sits on, if any. A click anywhere on the
 * command counts as on the reference, exactly as it does for `\input` — the
 * command word is part of the link, not a lead-in to it. Comments are blanked
 * first (same length, so offsets still line up): a commented-out `\ref` is not
 * something to follow. Pure.
 */
export function findTexKeyRefAt(source: string, caret: number): TexKeyRef | null {
  source = blankTexComments(source);
  TEX_KEYREF_RE.lastIndex = 0;
  for (let m = TEX_KEYREF_RE.exec(source); m; m = TEX_KEYREF_RE.exec(source)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret < start || caret > end) continue;
    const kind = classifyComplCmd(m[1]);
    if (!kind) return null;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    const key = pickToken(m[2], caret - braceStart);
    return key ? { kind, key } : null;
  }
  return null;
}

/**
 * Every `\ref{…}`/`\cite{…}` key range in the source, so the editor underlines a
 * cross-reference as the link it now is — the same decoration `texRefRanges`
 * gives a `\input`, and for the same reason: an affordance that only appears
 * under the pointer is one nobody knows to look for. One range per key, so
 * `\cite{a,b}` underlines two. Pure.
 */
export function texKeyRefRanges(source: string): TexRefRange[] {
  const ranges: TexRefRange[] = [];
  source = blankTexComments(source);
  TEX_KEYREF_RE.lastIndex = 0;
  for (let m = TEX_KEYREF_RE.exec(source); m; m = TEX_KEYREF_RE.exec(source)) {
    if (!classifyComplCmd(m[1])) continue;
    const braceStart = m.index + m[0].lastIndexOf("{") + 1;
    let pos = 0;
    for (const part of m[2].split(",")) {
      const lead = part.length - part.trimStart().length;
      const trimmed = part.trim();
      if (trimmed) {
        const start = braceStart + pos + lead;
        ranges.push({ start, end: start + trimmed.length });
      }
      pos += part.length + 1; // account for the comma
    }
  }
  return ranges;
}

/** Where a key is defined: the file to open (as something openable, so the
 *  caller reuses one open path) plus the 1-based line/column of the definition. */
export interface TexKeyLocation extends ResolvedTexRef {
  kind: TexComplKind;
  key: string;
  line: number;
  column: number;
}

/** The offset of the `\label{key}` defining `key`, or null. Comments blanked, so
 *  a commented-out label is not a definition; the key is compared trimmed, since
 *  `\label{ eq:1 }` and `\ref{eq:1}` are the same label to TeX. */
function findTexLabelOffset(text: string, key: string): number | null {
  const scan = blankTexComments(text);
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (let m = re.exec(scan); m; m = re.exec(scan)) {
    if (m[1].trim() === key) return m.index;
  }
  return null;
}

/**
 * Find where a `\ref`/`\cite` key is defined, across the whole document.
 *
 * A **ref** is looked for in the document's `.tex` sources ({@link
 * walkTexSources}), starting with the file the click came from — both because
 * that is where a label usually is and because it is the one file whose *draft*
 * can be handed in, so a label typed a minute ago and not yet saved is still
 * found. A **cite** is looked for in the `.bib` files the document names, at the
 * record's own first line.
 *
 * Null when nothing defines the key — a `\ref` to a label that does not exist is
 * an ordinary state of a document being written, so the caller must leave the
 * click alone rather than report an error over it.
 */
export async function resolveTexKeyRef(
  currentPath: string,
  ref: TexKeyRef,
  options: {
    projectId?: string | null;
    /** The unsaved buffer for `currentPath`, when the caller has one. */
    currentText?: string;
    disabled?: ReadonlySet<InternalViewer>;
  } = {},
): Promise<TexKeyLocation | null> {
  const { projectId = null, currentText, disabled } = options;
  const key = ref.key.trim();
  if (!key) return null;

  let hit: TexKeyLocation | null = null;
  const bibPaths = await walkTexSources(
    currentPath,
    projectId,
    (file, text) => {
      if (ref.kind !== "ref") return;
      const at = findTexLabelOffset(text, key);
      if (at == null) return;
      const open = viewerRefFor(file, disabled);
      if (!open) return;
      const { line, column } = offsetToLineCol(text, at);
      hit = { ...open, kind: ref.kind, key, line, column };
      return true;
    },
    { currentFirst: true, currentText },
  );
  if (hit || ref.kind === "ref") return hit;

  for (const bib of bibPaths) {
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: bib, projectId });
    } catch {
      continue;
    }
    const record = parseBib(text).records.find((r) => r.kind === "entry" && r.key === key);
    if (!record) continue;
    const open = viewerRefFor(bib, disabled);
    if (!open) continue;
    return { ...open, kind: ref.kind, key, line: record.line, column: 1 };
  }
  return null;
}

// --- Document structure (the TeX workspace's left sidebar) ------------------
//
// The single main `.tex` a workspace tab is opened on, enumerated as a tree of
// its inputted children (`\input`/`\include`/`\subfile`) and its graphics
// (`\includegraphics`), so the sidebar can list what makes up the document and
// let a click switch the center view to any of it. Built entirely on the tested
// helpers above (`texCommandTokens`/`resolveSibling` for children,
// `resolveTexRefAsync` for graphics, `parseTexSections` for the heading a node
// sits under) — this is only the bounded, best-effort walk that stitches them
// into a tree, matching `gatherTexCompletions`' conventions (≤60-file cap,
// missing/unreadable files skipped, no throw).

/** A `\includegraphics` target of one file: the resolved absolute path, its
 *  basename label, the viewer that renders it (image/pdf/…), and the nearest
 *  preceding section heading in the referencing file (if any). */
export interface TexGraphicNode {
  path: string;
  label: string;
  viewer: InternalViewer;
  section?: string;
}

/** One `.tex` file in the document tree: its inputted children in document
 *  order, its graphics, and the heading it sits under in its parent. */
export interface TexFileNode {
  path: string;
  label: string;
  /** The nearest preceding sectioning heading in the PARENT file, when this node
   *  was reached via an `\input`/`\include` under one. Absent for the root. */
  section?: string;
  graphics: TexGraphicNode[];
  children: TexFileNode[];
}

/** The parsed structure of a main document, rooted at the build root. */
export interface TexStructure {
  root: TexFileNode;
}

// `\cmd[opts]{arg}` for the child-file commands AND `\includegraphics`, captured
// WITH position so each referenced node can be attributed to the section it sits
// under (document order preserved by the global scan). Kept local to the walk
// below rather than folded into TEX_REF_RE, which also matches bibliography
// commands the sidebar does not list.
const TEX_STRUCT_RE = new RegExp(
  `\\\\(${[...TEX_INPUT_CMDS, "includegraphics"].join("|")})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`,
  "g",
);

/** The title of the last sectioning heading at or before `pos`, or undefined. */
function sectionAt(sections: Array<{ pos: number; title: string }>, pos: number): string | undefined {
  let title: string | undefined;
  for (const s of sections) {
    if (s.pos > pos) break;
    title = s.title;
  }
  return title;
}

/**
 * Enumerate `rootPath`'s document structure for the workspace sidebar: the tree
 * of inputted `.tex` children and the `\includegraphics` graphics of each, each
 * attributed to the sectioning heading it sits under. Bounded (≤60 files) and
 * best-effort — an unreadable or missing file becomes a leaf node rather than an
 * error, and a bare `\includegraphics{fig}` is resolved by probing its directory
 * (via `resolveTexRefAsync`) exactly as Ctrl+click does. `projectId` scopes the
 * file reads like `gatherTexCompletions`.
 */
export async function gatherTexStructure(
  rootPath: string,
  projectId: string | null = null,
  disabled?: ReadonlySet<InternalViewer>,
): Promise<TexStructure> {
  const seen = new Set<string>();

  const build = async (filePath: string, section: string | undefined): Promise<TexFileNode> => {
    seen.add(filePath);
    const node: TexFileNode = {
      path: filePath,
      label: basename(filePath),
      section,
      graphics: [],
      children: [],
    };
    let text: string;
    try {
      text = await invoke<string>("read_file_text", { path: filePath, projectId });
    } catch {
      return node; // missing/unreadable → a leaf, still shown
    }
    // Scan a comment-blanked copy (same length, so section offsets still line
    // up): a commented-out `\input{…}`/`\includegraphics{…}` — or a commented
    // `\section` — must not plant a phantom entry in the sidebar.
    const scan = blankTexComments(text);
    const sections = parseTexSections(scan);
    // One document-order pass over both kinds, so children and graphics are
    // gathered in the order they appear and can be attributed to their heading.
    const childJobs: Array<{ token: string; section?: string }> = [];
    const graphicJobs: Array<{ token: string; section?: string }> = [];
    TEX_STRUCT_RE.lastIndex = 0;
    for (let m = TEX_STRUCT_RE.exec(scan); m; m = TEX_STRUCT_RE.exec(scan)) {
      const cmd = m[1];
      const sec = sectionAt(sections, m.index);
      for (const part of m[2].split(",")) {
        const token = part.trim();
        if (!token) continue;
        if (cmd === "includegraphics") graphicJobs.push({ token, section: sec });
        else childJobs.push({ token, section: sec });
      }
    }
    // Resolve graphics (async — a bare stem lists its directory). Skipped when
    // nothing resolves, so a stale/removed figure never plants a dead entry.
    for (const g of graphicJobs) {
      const resolved = await resolveTexRefAsync(
        filePath,
        { command: "includegraphics", token: g.token },
        disabled,
      );
      if (resolved) {
        node.graphics.push({
          path: resolved.path,
          label: resolved.label,
          viewer: resolved.viewer,
          section: g.section,
        });
      }
    }
    // Recurse into inputted children in document order, honouring the cap and
    // skipping anything already visited (a cycle, or a file inputted twice).
    for (const c of childJobs) {
      if (seen.size >= 60) break;
      const childPath = resolveSibling(filePath, c.token, ".tex");
      if (seen.has(childPath)) continue;
      node.children.push(await build(childPath, c.section));
    }
    return node;
  };

  const root = await build(rootPath, undefined);
  return { root };
}
