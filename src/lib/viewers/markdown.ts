/**
 * A compact, dependency-free Markdown → HTML renderer for the built-in markdown
 * viewer (TODO Group K #40). It is a focused subset of CommonMark + the GitHub
 * flavour our project docs (README/STATUS/TODO/…) actually use: headings
 * (ATX + setext), fenced/indented code, blockquotes, GitHub alert callouts,
 * ordered/unordered/nested/task lists, pipe tables, horizontal rules,
 * paragraphs, and inline emphasis/code/links/images/auto-links.
 *
 * Fenced code blocks are syntax-highlighted by reusing the sibling
 * `highlight.ts` engine when the info string names a known language.
 *
 * SECURITY: the input is an arbitrary file's contents, so every raw run of text
 * is HTML-escaped FIRST; formatting is then layered on by emitting our own tags.
 * Raw HTML in the source is therefore shown as literal text, never injected, and
 * link hrefs are restricted to safe schemes. The highlighter shares the same
 * escape-first invariant. Keep this invariant if extending.
 */

import { highlight, type Lang } from "./highlight";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_HREF = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

/** Classify an image URL from `![alt](url)`. Remote `http(s)` and `data:image/`
 *  targets are emitted directly as the <img src>. Local targets (relative or
 *  absolute filesystem paths, or `file:`) can't be loaded by the webview from the
 *  app origin nor resolved here (the markdown file's directory is unknown), so
 *  they are reported as `local` for the viewer to resolve and inline from disk.
 *  Anything carrying another scheme (e.g. `javascript:`) is rejected. */
function imgSrc(url: string): { kind: "remote" | "local"; url: string } | null {
  const u = url.trim();
  if (!u) return null;
  if (/^(https?:\/\/|data:image\/)/i.test(u)) return { kind: "remote", url: u };
  if (/^file:/i.test(u)) return { kind: "local", url: u };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // other explicit scheme → reject
  return { kind: "local", url: u }; // no scheme → relative/absolute local path
}

/** #49: true when a (already-safe) href points at a local file rather than a
 *  remote/anchor target, so the markdown viewer can mark it visibly clickable.
 *  Relative paths, absolute paths, and the `file:` scheme count; http(s)/
 *  mailto/tel and pure `#anchor` links do not. */
function isLocalHref(href: string): boolean {
  return /^(file:|\/|\.\/|\.\.\/)/i.test(href.trim());
}

/** Map a fenced-code info string (the word after the opening ```) to a
 *  highlighter language, or null when we have no grammar for it. Covers the
 *  common aliases project docs use; unknown languages fall back to plain text. */
const FENCE_LANG: Record<string, Lang> = {
  js: "js", javascript: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js",
  mjs: "js", cjs: "js", node: "js",
  rust: "rust", rs: "rust",
  py: "python", python: "python",
  go: "go", golang: "go",
  c: "c", h: "c", "c++": "c", cpp: "c", cxx: "c", hpp: "c", java: "c",
  kotlin: "c", kt: "c", cs: "c", "c#": "c", csharp: "c", swift: "c", php: "c",
  scala: "c", dart: "c", objc: "c",
  sh: "shell", bash: "shell", shell: "shell", zsh: "shell", console: "shell",
  "shell-session": "shell", fish: "shell", ps1: "shell", powershell: "shell",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", conf: "toml", cfg: "toml", env: "toml", dotenv: "toml",
  css: "css", scss: "css", sass: "css", less: "css",
  sql: "sql",
  tex: "tex", latex: "tex",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
};

/** A slug for a heading's text, used as the heading `id` so in-document
 *  `#anchor` links resolve. Mirrors GitHub's scheme closely enough for our docs:
 *  lowercased, non-word characters dropped, spaces → hyphens. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Render inline constructs within already-block-split text. Input is raw
 *  (unescaped) markdown for one block; output is safe HTML. */
function renderInline(raw: string): string {
  // Pull inline code spans out first so their contents are not formatted.
  const codeSpans: string[] = [];
  let text = raw.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return ` C${idx} `;
  });

  // Pull links/images out next so their text/url are not mangled by emphasis.
  const links: string[] = [];
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) => {
    const altEsc = escapeHtml(alt);
    const img = imgSrc(url);
    // Local images get a placeholder (no `src`, so they don't 404 against the app
    // origin); the markdown viewer resolves `data-md-src` against the file's dir
    // and swaps in the bytes. Remote/data images are emitted directly.
    const html = !img
      ? `[${altEsc}]`
      : img.kind === "remote"
        ? `<img src="${escapeHtml(img.url)}" alt="${altEsc}" />`
        : `<img class="md-img-local" data-md-src="${escapeHtml(img.url)}" alt="${altEsc}" />`;
    const idx = links.push(html) - 1;
    return ` L${idx} `;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    const href = safeHref(url);
    const inner = renderInline(label);
    // #49: a link to a local file (relative/absolute path or file: scheme) gets a
    // `file-link` class so it reads as clickable, matching the editor's dotted
    // underline. Remote/anchor links keep the plain style.
    const fileCls = href && isLocalHref(href) ? ' class="file-link"' : "";
    const html = href
      ? `<a href="${escapeHtml(href)}"${fileCls} target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `[${inner}]`;
    const idx = links.push(html) - 1;
    return ` L${idx} `;
  });

  // Auto-link bare URLs (http(s):// or www.) into the same placeholder stream so
  // emphasis rules don't mangle their underscores. Trailing sentence punctuation
  // is left outside the link, matching GitHub.
  text = text.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/g, (m, pre: string, rawUrl: string) => {
    let url = rawUrl;
    let trail = "";
    const tm = url.match(/[.,;:!?)\]}]+$/);
    if (tm) {
      trail = url.slice(url.length - tm[0].length);
      url = url.slice(0, url.length - tm[0].length);
    }
    const href = safeHref(url.startsWith("www.") ? `https://${url}` : url);
    if (!href) return m;
    const html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    const idx = links.push(html) - 1;
    return `${pre} L${idx} ${trail}`;
  });

  // Escape everything else, then apply emphasis on the escaped text.
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Restore links then code spans.
  text = text.replace(/ L(\d+) /g, (_m, i: string) => links[Number(i)]);
  text = text.replace(/ C(\d+) /g, (_m, i: string) => codeSpans[Number(i)]);
  return text;
}

/** Highlight a fenced code block body, falling back to plain escaped text when
 *  the language is unknown or the highlighter declines. */
function renderCodeBlock(lang: string, body: string): string {
  const key = lang ? FENCE_LANG[lang.toLowerCase()] : undefined;
  const highlighted = key ? highlight(body, key) : null;
  const inner = highlighted ?? escapeHtml(body);
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre class="md-code"${langAttr}><code${cls}>${inner}</code></pre>`;
}

// ── GitHub alert callouts ──────────────────────────────────────────────────
const ALERT_KINDS: Record<string, string> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "caution",
};

const ALERT_TITLE: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

function renderBlockquote(rawLines: string[]): string {
  // GitHub alert syntax: first line is `[!NOTE]` (or TIP/IMPORTANT/WARNING/CAUTION),
  // the remainder is the body. Anything else is a plain blockquote.
  const first = rawLines[0]?.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
  if (first) {
    const kind = ALERT_KINDS[first[1].toUpperCase()];
    const body = rawLines.slice(1).join(" ").trim();
    const bodyHtml = body ? `<p>${renderInline(body)}</p>` : "";
    return (
      `<div class="md-alert md-alert-${kind}">` +
      `<p class="md-alert-title">${ALERT_TITLE[kind]}</p>` +
      bodyHtml +
      `</div>`
    );
  }
  return `<blockquote>${renderInline(rawLines.join(" "))}</blockquote>`;
}

// ── Tables ──────────────────────────────────────────────────────────────────
type Align = "left" | "right" | "center" | "";

/** Split a pipe-table row into cells, honouring `\|` escapes and trimming the
 *  optional leading/trailing pipes. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  // Drop empty leading/trailing cells produced by border pipes.
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Test whether `line` is a table delimiter row (e.g. `| --- | :--: |`). */
function isTableDelimiter(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitTableRow(line);
  if (!cells.length) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function alignFor(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function renderTable(header: string, delim: string, rows: string[]): string {
  const aligns = splitTableRow(delim).map(alignFor);
  const cell = (raw: string, tag: "th" | "td", i: number) => {
    const a = aligns[i] ?? "";
    const style = a ? ` style="text-align:${a}"` : "";
    return `<${tag}${style}>${renderInline(raw)}</${tag}>`;
  };
  const head =
    "<thead><tr>" +
    splitTableRow(header).map((c, i) => cell(c, "th", i)).join("") +
    "</tr></thead>";
  const body =
    "<tbody>" +
    rows
      .map(
        (r) =>
          "<tr>" + splitTableRow(r).map((c, i) => cell(c, "td", i)).join("") + "</tr>",
      )
      .join("") +
    "</tbody>";
  return `<table class="md-table">${head}${body}</table>`;
}

// ── Lists (nested + task items) ───────────────────────────────────────────────
type ListItem = {
  indent: number;
  type: "ul" | "ol";
  task: boolean | null;
  content: string[];
};

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Build the HTML for a collected list region using an indentation stack so
 *  nested lists render as nested <ul>/<ol>. Each item may be a GitHub task item
 *  (`- [ ]` / `- [x]`), rendered with a disabled checkbox. */
function renderList(items: ListItem[]): string {
  const parts: string[] = [];
  const stack: { type: "ul" | "ol"; indent: number }[] = [];

  const openItem = (it: ListItem): string => {
    const inner = renderInline(it.content.join(" "));
    if (it.task === null) return `<li>${inner}`;
    const checked = it.task ? " checked" : "";
    return (
      `<li class="task-item"><input type="checkbox" disabled${checked} />` +
      `<span>${inner}</span>`
    );
  };

  for (const it of items) {
    if (stack.length === 0) {
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
      continue;
    }
    if (it.indent > stack[stack.length - 1].indent) {
      // Deeper: open a nested list inside the still-open <li>.
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
      continue;
    }
    // Same level or shallower: close finished nested lists first.
    while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
      parts.push(`</li></${stack.pop()!.type}>`);
    }
    const top = stack[stack.length - 1];
    if (it.type !== top.type) {
      // Switching list kind at the same level: close and reopen.
      parts.push(`</li></${top.type}>`);
      stack.pop();
      stack.push({ type: it.type, indent: it.indent });
      parts.push(`<${it.type}>`, openItem(it));
    } else {
      parts.push(`</li>`, openItem(it));
    }
  }
  while (stack.length) parts.push(`</li></${stack.pop()!.type}>`);
  return parts.join("");
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const lang = fence[2].trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or EOF)
      out.push(renderCodeBlock(lang, body.join("\n")));
      continue;
    }

    // Blank line: ends paragraph.
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    // ATX heading.
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const id = slugify(heading[2]);
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      out.push(`<h${level}${idAttr}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading: a text line underlined by === (h1) or --- (h2). The HR rule
    // below also matches `---`, so this is only a heading when a paragraph line
    // precedes it; we detect that via the pending `paragraph` buffer being a
    // single line. Handled here before the HR check.
    if (
      paragraph.length === 1 &&
      /^\s*(=+|-+)\s*$/.test(line) &&
      !/^\s*$/.test(paragraph[0])
    ) {
      const level = line.trim().startsWith("=") ? 1 : 2;
      const textRaw = paragraph[0];
      paragraph = [];
      const id = slugify(textRaw);
      const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
      out.push(`<h${level}${idAttr}>${renderInline(textRaw)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr />");
      i++;
      continue;
    }

    // Table: a header row containing a pipe, immediately followed by a delimiter
    // row. Rows continue until a blank or non-pipe line.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      const header = line;
      const delim = lines[i + 1];
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      out.push(renderTable(header, delim, rows));
      continue;
    }

    // Blockquote / GitHub alert (consecutive `>` lines merged).
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(renderBlockquote(quote));
      continue;
    }

    // List items (ordered/unordered/nested/task). Collect the whole list region,
    // tolerating a single blank line between items and indented continuations.
    if (LIST_ITEM_RE.test(line)) {
      flushParagraph();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) {
          // A blank only continues the list if followed by another item or an
          // indented continuation line.
          const next = lines[i + 1];
          if (next != null && (LIST_ITEM_RE.test(next) || /^\s+\S/.test(next))) {
            i++;
            continue;
          }
          break;
        }
        const m = l.match(LIST_ITEM_RE);
        if (m) {
          const indent = m[1].replace(/\t/g, "    ").length;
          const ordered = /\d/.test(m[2]);
          let content = m[3];
          let task: boolean | null = null;
          const tm = !ordered && content.match(/^\[([ xX])\]\s+(.*)$/);
          if (tm) {
            task = tm[1].toLowerCase() === "x";
            content = tm[2];
          }
          items.push({ indent, type: ordered ? "ol" : "ul", task, content: [content] });
          i++;
          continue;
        }
        if (/^\s+\S/.test(l) && items.length) {
          // Indented continuation: fold into the previous item's text.
          items[items.length - 1].content.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(items));
      continue;
    }

    // Plain text → accumulate into the current paragraph.
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  return out.join("\n");
}
