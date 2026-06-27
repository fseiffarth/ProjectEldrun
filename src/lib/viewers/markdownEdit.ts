/**
 * Pure text transforms backing the Markdown editing toolbar (bold/italic/code/
 * heading/link/list) and the "Insert table of contents" action. Each transform
 * takes the buffer plus a selection `[start, end)` and returns the new buffer
 * with an updated selection, so the editor can apply it through its normal
 * set-value path (keeping undo/redo and highlighting consistent). Dependency-
 * free and exported for unit testing.
 */

export interface EditResult {
  value: string;
  selStart: number;
  selEnd: number;
}

/**
 * Toggle an inline `marker` (e.g. `**`, `_`, `` ` ``) around the selection. If
 * the selection is already wrapped — either the markers sit just outside it, or
 * they are the first/last characters of the selection — they are removed;
 * otherwise they are added. The selection is kept on the inner text.
 */
export function toggleInline(
  value: string,
  start: number,
  end: number,
  marker: string,
): EditResult {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const m = marker.length;

  // Markers immediately outside the selection → unwrap them.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -m) + sel + after.slice(m),
      selStart: start - m,
      selEnd: end - m,
    };
  }
  // Markers are the outermost chars of the selection → strip them.
  if (sel.length >= m * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, sel.length - m);
    return { value: before + inner + after, selStart: start, selEnd: start + inner.length };
  }
  // Otherwise wrap.
  return {
    value: before + marker + sel + marker + after,
    selStart: start + m,
    selEnd: end + m,
  };
}

/** The `[lineStart, lineEnd)` of the line containing offset `pos`. */
function lineBounds(value: string, pos: number): [number, number] {
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = value.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = value.length;
  return [lineStart, lineEnd];
}

/**
 * Cycle the heading level of the line at `pos`: none → `#` → `##` → `###` →
 * none. The caret is kept at the same place within the line text.
 */
export function cycleHeading(value: string, pos: number): EditResult {
  const [ls, le] = lineBounds(value, pos);
  const line = value.slice(ls, le);
  const m = line.match(/^(#{1,6})\s+/);
  const cur = m ? m[1].length : 0;
  const rest = m ? line.slice(m[0].length) : line.replace(/^\s+/, "");
  const next = cur >= 3 ? 0 : cur + 1;
  const newLine = next === 0 ? rest : `${"#".repeat(next)} ${rest}`;
  const delta = newLine.length - line.length;
  const caret = Math.max(ls, pos + delta);
  return {
    value: value.slice(0, ls) + newLine + value.slice(le),
    selStart: caret,
    selEnd: caret,
  };
}

/**
 * Toggle a line `prefix` (e.g. `"- "` for a bullet list) on every line the
 * selection touches: if all such lines already carry it, remove it; otherwise
 * add it. The selection is expanded to cover the affected lines.
 */
export function toggleLinePrefix(
  value: string,
  start: number,
  end: number,
  prefix: string,
): EditResult {
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  let blockEnd = value.indexOf("\n", end > start ? end - 1 : end);
  if (blockEnd === -1) blockEnd = value.length;
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
    .join("\n");
  return {
    value: value.slice(0, blockStart) + next + value.slice(blockEnd),
    selStart: blockStart,
    selEnd: blockStart + next.length,
  };
}

/**
 * Wrap the selection as a Markdown link `[text](url)`. With a non-empty
 * selection it becomes the link text and the `url` placeholder is selected;
 * with no selection a `text` placeholder is selected so the user can type it.
 */
export function makeLink(value: string, start: number, end: number): EditResult {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (sel) {
    const inserted = `[${sel}](url)`;
    const urlStart = start + sel.length + 3; // after "[sel]("
    return { value: before + inserted + after, selStart: urlStart, selEnd: urlStart + 3 };
  }
  const inserted = "[text](url)";
  return { value: before + inserted + after, selStart: start + 1, selEnd: start + 5 };
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

interface Heading {
  level: number;
  title: string;
}

/** Collect ATX (`#`) headings in document order, skipping fenced code blocks. */
function collectHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let fence = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fence = fenceMatch[1][0];
      } else if (line.trimStart().startsWith(fence)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2].trim()) out.push({ level: m[1].length, title: m[2].trim() });
  }
  return out;
}

/**
 * Generate a Markdown table-of-contents list from the document's ATX headings,
 * nested by level (relative to the shallowest heading) and linking to each
 * heading's GitHub-style anchor. Returns an empty string when there are no
 * headings.
 */
export function generateToc(markdown: string): string {
  const headings = collectHeadings(markdown);
  if (headings.length === 0) return "";
  const min = Math.min(...headings.map((h) => h.level));
  const seen = new Map<string, number>();
  return headings
    .map((h) => {
      const base = slugify(h.title);
      // De-dupe repeated headings the way GitHub does: append -1, -2, …
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const anchor = n === 0 ? base : `${base}-${n}`;
      const indent = "  ".repeat(h.level - min);
      return `${indent}- [${h.title}](#${anchor})`;
    })
    .join("\n");
}
