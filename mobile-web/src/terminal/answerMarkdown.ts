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
 */
export function answerHtml(text: string): string {
  return renderMarkdown(text)
    .replace(/<a\b[^>]*>/g, '<span class="md-link">')
    .replace(/<\/a>/g, "</span>")
    .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, "$1")
    .replace(/<img\b[^>]*>/g, "")
    .replace(/<span class="md-img-remote"[^>]*>/g, '<span class="md-img-remote">')
    .replace(/<input type="checkbox" data-md-task( checked)? \/>/g, (_m, checked?: string) =>
      `<span class="md-task" aria-hidden="true">${checked ? "☑" : "☐"}</span>`)
    .replace(/<(h[1-6]) id="[^"]*">/g, "<$1>");
}
