import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../lib/viewers/markdown";

describe("renderMarkdown", () => {
  it("renders ATX headings", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("### Sub")).toContain("<h3>Sub</h3>");
  });

  it("renders bold, italic, and inline code", () => {
    const html = renderMarkdown("a **b** and *c* and `d`");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>c</em>");
    expect(html).toContain("<code>d</code>");
  });

  it("renders fenced code blocks without applying inline formatting inside", () => {
    const html = renderMarkdown("```js\nconst x = **not bold**;\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("language-js");
    expect(html).toContain("**not bold**"); // not transformed
    expect(html).not.toContain("<strong>");
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
  });

  it("renders safe links and drops dangerous schemes", () => {
    expect(renderMarkdown("[ok](https://example.com)")).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    const bad = renderMarkdown("[x](javascript:alert(1))");
    expect(bad).not.toContain("javascript:");
    expect(bad).not.toContain("<a ");
  });

  it("escapes raw HTML so file contents cannot inject markup", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders blockquotes and horizontal rules", () => {
    expect(renderMarkdown("> quoted")).toContain("<blockquote>quoted</blockquote>");
    expect(renderMarkdown("---")).toContain("<hr />");
  });
});
