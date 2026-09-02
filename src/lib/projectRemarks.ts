import { isAbsolute, isPathWithin, normalizePath, resolvePath } from "./paths";
import { stripFormatControls } from "./textSafety";
import { isLocalHref, splitLineHint } from "./viewers/markdown";

export const REMARKS_FILE = "REMARKS.md";
export const REMARKS_TEMPLATE = `# Remarks

Per-file remarks. One bullet per remark:
\`- [ ] [<path>:<line>](./<path>:<line>) — text\`. Line optional, a hint only.
Tick a box to resolve a remark. Everything else in this file is yours.
`;

export interface ProjectRemark {
  file: string;
  line: number | null;
  text: string;
  done: boolean;
  /** Zero-based source-line span, `[srcStart, srcEnd)`. */
  srcStart: number;
  srcEnd: number;
  invalidPath: boolean;
}

interface SourceLine { text: string; ending: string }

function sourceLines(src: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) && (match[0] || re.lastIndex < src.length)) {
    lines.push({ text: match[1], ending: match[2] });
    if (!match[2]) break;
  }
  return lines;
}

function cleanRelativePath(raw: string): { file: string; invalidPath: boolean } {
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep malformed escapes */ }
  decoded = decoded.replace(/^\.\//, "").replace(/\\/g, "/");
  const absolute = isAbsolute(decoded) || /^file:/i.test(decoded);
  const parts: string[] = [];
  let escaped = absolute;
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      else escaped = true;
    } else parts.push(part);
  }
  return { file: parts.join("/"), invalidPath: escaped || parts.length === 0 };
}

const BULLET_RE = /^- \[([ xX])\] \[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(.*)$/;

export function parseRemarks(src: string): ProjectRemark[] {
  const lines = sourceLines(src);
  const remarks: ProjectRemark[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].text.match(BULLET_RE);
    if (!match || !isLocalHref(match[3])) continue;
    const hinted = splitLineHint(match[3]);
    const path = cleanRelativePath(hinted.href.replace(/[?#].*$/, ""));
    let rest = match[4].replace(/^\s+(?:—|-)\s+/, "").trimEnd();
    let end = i + 1;
    while (end < lines.length && /^(?: {2,}|\t)\S?/.test(lines[end].text)) {
      const continuation = lines[end].text.replace(/^(?: {2}|\t)/, "");
      rest += `${rest ? "\n" : ""}${continuation}`;
      end += 1;
    }
    remarks.push({
      file: path.file,
      line: hinted.line,
      text: stripFormatControls(rest),
      done: match[1].toLowerCase() === "x",
      srcStart: i,
      srcEnd: end,
      invalidPath: path.invalidPath,
    });
    i = end - 1;
  }
  return remarks;
}

export function remarkCountsByFile(remarks: ProjectRemark[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const remark of remarks) {
    if (!remark.done && !remark.invalidPath) counts[remark.file] = (counts[remark.file] ?? 0) + 1;
  }
  return counts;
}

function safeText(text: string): string[] {
  const cleaned = stripFormatControls(text).replace(/\r\n?/g, "\n").trim();
  return cleaned.split("\n");
}

export function formatRemarkBullet(file: string, line: number | null, text: string, done = false): string {
  const clean = cleanRelativePath(file).file;
  const target = `${clean}${line != null ? `:${Math.max(1, Math.trunc(line))}` : ""}`;
  const label = target.split("[").join("").split("]").join("");
  const encoded = target.split("/").map(encodeURIComponent).join("/").replace(/%3A(\d+)$/i, ":$1");
  const parts = safeText(text);
  const first = parts.shift() ?? "";
  return `- [${done ? "x" : " "}] [${label}](./${encoded}) — ${first}${
    parts.length ? `\n${parts.map((part) => `  ${part}`).join("\n")}` : ""
  }`;
}

function newlineOf(src: string): string { return src.includes("\r\n") ? "\r\n" : "\n"; }

export function addRemark(src: string, file: string, line: number | null, text: string): string {
  const nl = newlineOf(src);
  const bullet = formatRemarkBullet(file, line, text).replace(/\n/g, nl);
  const heading = `## ${cleanRelativePath(file).file}`;
  const lines = sourceLines(src);
  let headingLine = -1;
  for (let i = 0; i < lines.length; i += 1) if (lines[i].text.trim() === heading) headingLine = i;
  if (headingLine >= 0) {
    let insert = lines.length;
    for (let i = headingLine + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i].text)) { insert = i; break; }
    }
    const before = lines.slice(0, insert).map((l) => l.text + l.ending).join("");
    const after = lines.slice(insert).map((l) => l.text + l.ending).join("");
    const pad = before.endsWith(nl + nl) ? "" : before.endsWith(nl) ? nl : nl + nl;
    return `${before}${pad}${bullet}${nl}${after}`;
  }
  const pad = !src ? "" : src.endsWith(nl + nl) ? "" : src.endsWith(nl) ? nl : nl + nl;
  return `${src}${pad}${heading}${nl}${nl}${bullet}${nl}`;
}

function identity(remarks: ProjectRemark[], target: ProjectRemark): ProjectRemark | null {
  const first = target.text.split("\n", 1)[0];
  const before = remarks.filter((r) =>
    r.file === target.file && r.line === target.line && r.text.split("\n", 1)[0] === first
      && r.srcStart < target.srcStart,
  ).length;
  return remarks.filter((r) =>
    r.file === target.file && r.line === target.line && r.text.split("\n", 1)[0] === first,
  )[before] ?? null;
}

function spliceRemark(src: string, target: ProjectRemark, replacement: string): string | null {
  const found = identity(parseRemarks(src), target);
  if (!found) return null;
  const lines = sourceLines(src);
  const nl = found.srcStart < lines.length ? lines[found.srcStart].ending || newlineOf(src) : newlineOf(src);
  const finalEnding = lines[found.srcEnd - 1]?.ending ?? "";
  const before = lines.slice(0, found.srcStart).map((l) => l.text + l.ending).join("");
  const after = lines.slice(found.srcEnd).map((l) => l.text + l.ending).join("");
  return before + (replacement ? replacement.replace(/\n/g, nl) + finalEnding : "") + after;
}

export function editRemarkText(src: string, remark: ProjectRemark, text: string): string | null {
  return spliceRemark(src, remark, formatRemarkBullet(remark.file, remark.line, text, remark.done));
}
export function removeRemark(src: string, remark: ProjectRemark): string | null {
  return spliceRemark(src, remark, "");
}
export function setRemarkDone(src: string, remark: ProjectRemark, done: boolean): string | null {
  if (remark.done === done) return src;
  return spliceRemark(src, remark, formatRemarkBullet(remark.file, remark.line, remark.text, done));
}

export function resolveRemarkAbsPath(projectDir: string, rel: string): string | null {
  const clean = cleanRelativePath(rel);
  if (clean.invalidPath) return null;
  const root = normalizePath(projectDir);
  const abs = resolvePath(root, clean.file);
  return isPathWithin(abs, root) && abs !== root ? abs : null;
}
