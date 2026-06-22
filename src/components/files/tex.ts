import { invoke } from "@tauri-apps/api/core";
import { internalViewerFor, type FileEntry, type InternalViewer } from "./fileUtils";

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

/** Forward search: where in `pdf` does `input:line:column` land. Resolves to
 *  null on any error / no hit. */
export function synctexView(
  pdf: string,
  input: string,
  line: number,
  column: number,
): Promise<SyncRect | null> {
  return invoke<SyncRect | null>("synctex_view", { pdf, input, line, column }).catch(() => null);
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
export function resolveTexRef(currentPath: string, target: TexRefTarget): ResolvedTexRef | null {
  const def = TEX_REF_COMMANDS[target.command] ?? null;
  const token = target.token.trim();
  if (!token) return null;

  const base = token.slice(token.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const hasExt = dot > 0 && dot < base.length - 1;
  const rel = hasExt ? token : def == null ? null : token + def;
  if (rel == null) return null;

  const dir = currentPath.slice(0, currentPath.lastIndexOf("/"));
  const abs = rel.startsWith("/") ? normalizePath(rel) : normalizePath(`${dir}/${rel}`);
  const name = abs.slice(abs.lastIndexOf("/") + 1);
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
  const viewer = internalViewerFor(entry);
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
): Promise<ResolvedTexRef | null> {
  const direct = resolveTexRef(currentPath, target);
  if (direct) return direct;
  if (target.command !== "includegraphics") return null;

  const token = target.token.trim();
  if (!token) return null;
  const slash = token.lastIndexOf("/");
  const sub = slash >= 0 ? token.slice(0, slash) : "";
  const stem = (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
  if (!stem) return null;

  const dir = currentPath.slice(0, currentPath.lastIndexOf("/"));
  const absDir = token.startsWith("/")
    ? normalizePath(sub || "/")
    : normalizePath(`${dir}/${sub}`);

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
  const viewer = internalViewerFor(best.entry);
  if (!viewer) return null;
  return { path: best.entry.path, viewer, label: best.entry.name };
}

/** Collapse `.`/`..` segments in a `/`-separated path, preserving a leading `/`. */
function normalizePath(p: string): string {
  const isAbs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? "/" : "") + out.join("/");
}
