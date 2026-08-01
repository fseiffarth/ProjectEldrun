import { describe, it, expect } from "vitest";
import { renderMarkdown, toggleTaskCheckbox } from "../lib/viewers/markdown";

describe("renderMarkdown", () => {
  it("renders ATX headings", () => {
    expect(renderMarkdown("# Title")).toContain('<h1 id="title">Title</h1>');
    expect(renderMarkdown("### Sub")).toContain('<h3 id="sub">Sub</h3>');
  });

  it("renders bold, italic, and inline code", () => {
    const html = renderMarkdown("a **b** and *c* and `d`");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>c</em>");
    expect(html).toContain("<code>d</code>");
  });

  it("renders fenced code blocks without applying inline formatting inside", () => {
    const html = renderMarkdown("```js\nconst x = **not bold**;\n```");
    expect(html).toContain('<pre class="md-code"');
    expect(html).toContain("language-js");
    expect(html).toContain("**not bold**"); // not transformed
    expect(html).not.toContain("<strong>");
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol><li>a</li><li>b</li></ol>");
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

  it("renders GFM pipe tables with alignment", () => {
    const html = renderMarkdown("| A | B |\n| :-- | --: |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<thead><tr><th");
    expect(html).toContain(">A</th>");
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain("<tbody><tr><td");
    expect(html).toContain(">2</td>");
  });

  it("does not treat an ordinary pipe line as a table", () => {
    const html = renderMarkdown("a | b is just text");
    expect(html).not.toContain("<table");
    expect(html).toContain("<p>");
  });

  it("renders task list checkboxes with checked state", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done");
    expect(html).toContain('class="task-item"');
    // Live (not disabled) checkboxes, tagged for the preview's click handler.
    expect(html).toContain('<input type="checkbox" data-md-task />');
    expect(html).toContain('<input type="checkbox" data-md-task checked />');
    expect(html).not.toContain("disabled");
    expect(html).toContain("<span>todo</span>");
    expect(html).toContain("<span>done</span>");
  });

  it("renders nested lists", () => {
    const html = renderMarkdown("- a\n  - b\n  - c\n- d");
    // The nested <ul> sits inside the first item, before it closes.
    expect(html).toContain("<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>");
  });

  it("renders GitHub alert callouts", () => {
    const html = renderMarkdown("> [!WARNING]\n> Be careful here.");
    expect(html).toContain('class="md-alert md-alert-warning"');
    expect(html).toContain('class="md-alert-title">Warning</p>');
    expect(html).toContain("Be careful here.");
    expect(html).not.toContain("<blockquote>");
  });

  it("syntax-highlights known fenced code languages", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain('class="md-code"');
    expect(html).toContain('data-lang="js"');
    expect(html).toContain('class="tok-keyword">const</span>');
  });

  it("auto-links bare URLs without mangling underscores", () => {
    const html = renderMarkdown("see https://example.com/a_b for more");
    expect(html).toContain(
      '<a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer">https://example.com/a_b</a>',
    );
    expect(html).not.toContain("<em>");
  });

  it("renders setext headings", () => {
    expect(renderMarkdown("Title\n=====")).toContain("<h1");
    expect(renderMarkdown("Title\n=====")).toContain(">Title</h1>");
    expect(renderMarkdown("Sub\n---")).toContain("<h2");
  });

  it("gives headings slug ids for in-document anchors", () => {
    expect(renderMarkdown("## Hello World")).toContain('<h2 id="hello-world">');
  });

  it("emits remote and data images directly", () => {
    expect(renderMarkdown("![badge](https://img.shields.io/x.svg)")).toContain(
      '<img src="https://img.shields.io/x.svg" alt="badge" />',
    );
    expect(renderMarkdown("![d](data:image/png;base64,AAAA)")).toContain(
      '<img src="data:image/png;base64,AAAA" alt="d" />',
    );
  });

  it("tags local images for the viewer to resolve from disk", () => {
    for (const src of ["images/logo.png", "./docs/logo.png", "../a/b.png", "/abs/y.png"]) {
      const html = renderMarkdown(`![logo](${src})`);
      expect(html).toContain(`<img class="md-img-local" data-md-src="${src}" alt="logo" />`);
    }
    // The title clause is stripped from the resolved path.
    expect(renderMarkdown('![logo](./l.png "a title")')).toContain('data-md-src="./l.png"');
  });

  it("rejects images with an unsafe scheme", () => {
    const html = renderMarkdown("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
  });
});

describe("toggleTaskCheckbox", () => {
  it("checks an unchecked task and unchecks a checked one", () => {
    const src = "- [ ] a\n- [x] b";
    expect(toggleTaskCheckbox(src, 0)).toBe("- [x] a\n- [x] b");
    expect(toggleTaskCheckbox(src, 1)).toBe("- [ ] a\n- [ ] b");
  });

  it("preserves indentation, bullet char, and trailing text byte-for-byte", () => {
    const src = "  * [ ]   nested item  ";
    expect(toggleTaskCheckbox(src, 0)).toBe("  * [x]   nested item  ");
  });

  it("normalizes an uppercase X only when it flips it off", () => {
    // `[X]` reads as checked, so toggling it produces `[ ]`; the letter case only
    // ever appears on the checked side, which the toggle removes.
    expect(toggleTaskCheckbox("- [X] done", 0)).toBe("- [ ] done");
  });

  it("counts tasks in document order across non-task lines", () => {
    const src = "- [ ] one\nsome text\n- [ ] two\n- [ ] three";
    expect(toggleTaskCheckbox(src, 2)).toBe(
      "- [ ] one\nsome text\n- [ ] two\n- [x] three",
    );
  });

  it("skips `- [ ]` lines inside fenced code blocks", () => {
    // The fenced line renders as code, not a checkbox, so it must not be counted:
    // index 0 is the real task after the fence closes.
    const src = "```\n- [ ] not a task\n```\n- [ ] real";
    expect(toggleTaskCheckbox(src, 0)).toBe("```\n- [ ] not a task\n```\n- [x] real");
  });

  it("does not count ordered-list items (no checkbox is rendered for them)", () => {
    // `1. [ ]` is not a GFM task item; only the bullet line is.
    const src = "1. [ ] ordered\n- [ ] bullet";
    expect(toggleTaskCheckbox(src, 0)).toBe("1. [ ] ordered\n- [x] bullet");
  });

  it("returns null when the index names no task", () => {
    expect(toggleTaskCheckbox("- [ ] only", 1)).toBeNull();
    expect(toggleTaskCheckbox("no tasks here", 0)).toBeNull();
  });
});
// Link labels (images/code/math inside `[…](…)`) and the placeholder scheme they
// share are covered in MarkdownLinkLabel.test.ts.
