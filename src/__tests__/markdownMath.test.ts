import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../lib/viewers/markdown";

/**
 * Dev A: math placeholder emission from the pure markdown renderer. The actual
 * KaTeX/mermaid DOM rendering happens in `enrichMarkdownDom` (a post-render DOM
 * pass), so here we only assert that renderMarkdown emits the right placeholders.
 */
describe("renderMarkdown — math + mermaid placeholders", () => {
  it("emits an inline math span for $…$", () => {
    const html = renderMarkdown("$x^2$");
    expect(html).toContain('class="md-math"');
    expect(html).toContain('data-display="false"');
    // TeX is HTML-escaped (escape-first invariant); `^` survives verbatim.
    expect(html).toContain("x^2");
  });

  it("emits a block math span for $$…$$", () => {
    const html = renderMarkdown("$$a$$");
    expect(html).toContain('class="md-math"');
    expect(html).toContain('data-display="true"');
  });

  it("does NOT treat prose dollar amounts as math", () => {
    const html = renderMarkdown("It cost $5 today");
    expect(html).not.toContain("md-math");
  });

  it("does NOT treat a $ with adjacent spaces as math", () => {
    const html = renderMarkdown("a $ b $ c");
    expect(html).not.toContain("md-math");
  });

  it("HTML-escapes the TeX inside the math span", () => {
    const html = renderMarkdown("$a<b$");
    expect(html).toContain('class="md-math"');
    expect(html).toContain("a&lt;b");
    expect(html).not.toContain("a<b");
  });

  it("leaves inline code spans untouched (no math extraction inside)", () => {
    const html = renderMarkdown("`$x$`");
    expect(html).toContain("<code>$x$</code>");
    expect(html).not.toContain("md-math");
  });

  it("renders ```mermaid fences as a mermaid code block for the enrich pass", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    expect(html).toContain('data-lang="mermaid"');
    expect(html).toContain('class="language-mermaid"');
    // Source is escaped and present so enrichMarkdownDom can read textContent.
    expect(html).toContain("A--&gt;B;");
  });
});
