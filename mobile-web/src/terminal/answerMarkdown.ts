import { renderMarkdown } from "../../../src/lib/viewers/markdown";

/**
 * An agent's answer in the Focus chat as formatted text: the desktop
 * viewer's renderer (`renderMarkdown`, escape-first, so the answer's own HTML
 * is shown as text), then made inert for a phone. Only the formatting is
 * kept — headings, lists, emphasis, code, tables, quotes. Nothing in an
 * answer opens or loads anything: a link is its label, an image is its alt
 * text, a task box is a glyph, and headings carry no ids to collide across
 * bubbles.
 *
 * The rewrites run on the renderer's own markup. Every attribute value in it
 * went through `escapeHtml`, so none holds a `"` or `>` and the patterns
 * below cannot be steered by the answer's text.
 *
 * The result is then rebuilt through an allowlist (`allowlisted`) that holds
 * whether or not that is still true: an answer is written by an agent that
 * may have read anything, and this lands in `innerHTML`. Only the tags the
 * renderer emits survive, only its own classes, and a `style` only as a table
 * cell's alignment — so a renderer change that let the answer's text reach
 * the markup could still not open, load, run or restyle anything.
 */
export function answerHtml(text: string): string {
  return allowlisted(renderMarkdown(text)
    .replace(/<a\b[^>]*>/g, '<span class="md-link">')
    .replace(/<\/a>/g, "</span>")
    .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, "$1")
    .replace(/<img\b[^>]*>/g, "")
    .replace(/<span class="md-img-remote"[^>]*>/g, '<span class="md-img-remote">')
    .replace(/<input type="checkbox" data-md-task( checked)? \/>/g, (_m, checked?: string) =>
      `<span class="md-task" aria-hidden="true">${checked ? "☑" : "☐"}</span>`)
    .replace(/<(h[1-6]) id="[^"]*">/g, "<$1>"));
}

/** What the renderer emits once the rewrites above are done. Another element
 * is unwrapped: it goes, its text stays. */
const TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "div", "span",
  "ul", "ol", "li", "strong", "em", "del", "code", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
]);
/** Elements whose content is not text to read — it goes with them. */
const DROPPED = new Set([
  "script", "style", "template", "noscript", "textarea", "title", "iframe", "object", "embed", "svg", "math", "select",
]);
/** The renderer's own class names (`md-*`, the highlighter's `tok-*`, a code
 * block's `language-*`). Anything else could dress an answer in the app's own
 * chrome — a bubble, a banner — so it goes. */
const OWN_CLASS = /^(?:md-[a-z-]+|tok-[a-z-]+|language-[\w+#.-]+|task-item)$/;
/** The only style the renderer writes: a table column's alignment. */
const CELL_ALIGN = /^text-align:(?:left|center|right)$/;
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * `html` rebuilt from nothing but allowed elements, their allowed attributes
 * and text. It is parsed into a `<template>`, whose content is inert — no
 * script runs, nothing loads — and nothing parsed is ever moved out of it:
 * the output is new nodes, so an attribute or element nobody listed cannot
 * ride along. What is serialized holds only plain HTML elements and text, so
 * reading it back parses to the same tree.
 */
function allowlisted(html: string): string {
  const parsed = document.createElement("template");
  parsed.innerHTML = html;
  const out = document.createElement("div");
  copyChildren(parsed.content, out);
  return out.innerHTML;
}

function copyChildren(from: Node, to: Node): void {
  from.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName;
    if (DROPPED.has(tag)) return;
    if (element.namespaceURI !== HTML_NS || !TAGS.has(tag)) {
      copyChildren(element, to);
      return;
    }
    const copy = document.createElement(tag);
    const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter((name) => OWN_CLASS.test(name));
    if (classes.length > 0) copy.setAttribute("class", classes.join(" "));
    const style = element.getAttribute("style")?.trim();
    if (style && CELL_ALIGN.test(style)) copy.setAttribute("style", style);
    if (element.getAttribute("aria-hidden") === "true") copy.setAttribute("aria-hidden", "true");
    copyChildren(element, copy);
    to.appendChild(copy);
  });
}
