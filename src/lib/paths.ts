/**
 * OS-independent path helpers for the frontend (cross-platform support).
 *
 * Absolute paths reach the UI straight from the Rust backend, which emits NATIVE
 * separators: `/` on Unix, `\` (with a `C:` drive, or a `\\server` UNC prefix) on
 * Windows. Relative ("rel") paths from the backend are already normalised to `/`
 * (see `commands/fs.rs`, which does `.replace('\\', "/")`). These helpers
 * therefore accept EITHER separator so the same component code runs on both
 * platforms, and when they build a new path they preserve the input's own
 * separator style — falling back to the host OS only for a separator-less input.
 *
 * Rust's `std::fs` accepts `/` on Windows too, so a `/`-joined path handed back to
 * the backend still resolves; we keep native separators mainly so labels,
 * `file://` URIs, and round-tripped paths read correctly.
 */

// OS detection lives in the dependency-free `platform.ts` single source of
// truth. Imported for local use (sepFor) AND re-exported under the stable
// `IS_WINDOWS` name this widely-imported module has always exposed. Only
// consulted when a path's own separators can't reveal its style (e.g. a bare
// relative segment with no separator at all).
import { IS_WINDOWS } from "./platform";

export { IS_WINDOWS };

/** A Windows drive prefix like `C:` (anchored at the start). */
const DRIVE_RE = /^[a-zA-Z]:(?=[/\\]|$)/;

/** The separator to use when building onto `p`: matches the path's own style, or
 *  the host OS when the path carries no separators to learn from. */
function sepFor(p: string): "/" | "\\" {
  if (p.includes("\\") || DRIVE_RE.test(p) || p.startsWith("\\\\")) return "\\";
  if (p.includes("/")) return "/";
  return IS_WINDOWS ? "\\" : "/";
}

/** Does this path use Windows conventions (drive letter, UNC, or any backslash)?
 *  Mixed separators (`C:/a\b`) count as Windows. */
function isWinStyle(p: string): boolean {
  return DRIVE_RE.test(p) || p.startsWith("\\\\") || p.includes("\\");
}

/** Index of the last separator of either kind, or -1. */
function lastSep(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

/** True for an absolute path on either OS: POSIX `/x`, Windows `C:\x` / `C:/x`,
 *  or a `\\server\share` UNC path. */
export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[/\\]/.test(p);
}

/** Final path segment (the file or last directory name). Trailing separators are
 *  ignored; a bare root (`/`, `C:\`, `C:`) yields "". Works on both native and
 *  forward-slash paths, so it is safe on backend rel paths too. */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = lastSep(trimmed);
  const base = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  // A lone drive ("C:") is a root, not a name.
  return DRIVE_RE.test(base) ? "" : base;
}

/** Everything up to (not including) the final separator — the containing
 *  directory. Preserves the root: dirname("/a")→"/", dirname("C:\\a")→"C:\\".
 *  Returns "" when `p` has no directory part (callers that need a root fallback
 *  keep their own `|| "/"`). */
export function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = lastSep(trimmed);
  if (i < 0) return "";
  if (i === 0) return trimmed[0]; // POSIX root: "/x" → "/"
  const head = trimmed.slice(0, i);
  // Windows drive root: "C:\x" (separator at index 2) → "C:\"
  if (DRIVE_RE.test(head) && head.length === 2) return trimmed.slice(0, i + 1);
  return head;
}

/** Normalise `.`/`..`/duplicate-separator segments, preserving the root and the
 *  path's separator style. */
export function normalizePath(p: string): string {
  const sep = sepFor(p);
  const win = isWinStyle(p);

  let root = "";
  let body = p;
  if (win) {
    const drive = p.match(DRIVE_RE);
    if (drive) {
      root = drive[0] + sep; // "C:" + sep
      body = p.slice(drive[0].length);
    } else if (p.startsWith("\\\\")) {
      root = sep + sep; // UNC "\\"
      body = p.slice(2);
    } else if (/^[/\\]/.test(p)) {
      root = sep;
      body = p.slice(1);
    }
  } else if (p.startsWith("/")) {
    root = "/";
    body = p.slice(1);
  }

  const out: string[] = [];
  for (const seg of body.split(/[/\\]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!root) out.push("..");
    } else out.push(seg);
  }
  return root + out.join(sep);
}

/** Resolve `target` against the directory `baseDir`. An absolute `target` is
 *  normalised and returned as-is; a relative one is joined onto `baseDir`. The
 *  result keeps `baseDir`'s separator style. */
export function resolvePath(baseDir: string, target: string): string {
  if (isAbsolute(target)) return normalizePath(target);
  const sep = sepFor(baseDir);
  return normalizePath(`${baseDir}${sep}${target}`);
}

/** Build a `file://` URI from an absolute local path, percent-encoding each
 *  segment. Windows drive paths become `file:///C:/…` (extra `/`, forward
 *  slashes) and UNC paths `file://server/share/…`, per RFC 8089. */
export function toFileUri(p: string): string {
  if (isWinStyle(p)) {
    const encoded = p
      .split(/[/\\]+/)
      .filter((s) => s !== "")
      // Keep the drive letter (`C:`) literal — encodeURIComponent would turn its
      // colon into %3A, which file:// consumers don't accept.
      .map((s, i) => (i === 0 && DRIVE_RE.test(s) ? s : encodeURIComponent(s)))
      .join("/");
    return p.startsWith("\\\\")
      ? `file://${encoded}` // UNC: file://server/share/…
      : `file:///${encoded}`; // drive: file:///C:/…
  }
  // POSIX: keep the leading "" from the absolute path so we get file:///abs/path.
  return `file://${p.split("/").map(encodeURIComponent).join("/")}`;
}

/** Convert a `file://` URI back to an absolute local path (decoding `%20` etc.),
 *  dropping any `file://host/…` authority and the extra leading slash Windows
 *  drive URIs carry (`file:///C:/…` → `C:/…`). Returns null for non-`file:` input. */
export function fromFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let rest = uri.slice("file://".length);
  // file://host/path — drop the authority (but not a Windows `file:///C:/…`,
  // whose first slash starts the path).
  const slash = rest.indexOf("/");
  if (slash > 0) rest = rest.slice(slash);
  // file:///C:/… leaves a leading slash before the drive letter — strip it.
  rest = rest.replace(/^\/([a-zA-Z]:)/, "$1");
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
