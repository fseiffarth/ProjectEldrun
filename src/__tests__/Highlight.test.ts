import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, highlight, languageForPath } from "../lib/viewers/highlight";

describe("languageForPath", () => {
  it("maps extensions to languages", () => {
    expect(languageForPath("/a/b/main.rs")).toBe("rust");
    expect(languageForPath("script.py")).toBe("python");
    expect(languageForPath("app.tsx")).toBe("js");
    expect(languageForPath("data.json")).toBe("json");
    expect(languageForPath("page.html")).toBe("markup");
    expect(languageForPath("icon.svg")).toBe("markup");
    expect(languageForPath("style.scss")).toBe("css");
    expect(languageForPath("paper.tex")).toBe("tex");
    expect(languageForPath("macros.sty")).toBe("tex");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("notes.markdown")).toBe("markdown");
  });

  it("maps well-known extensionless filenames", () => {
    expect(languageForPath("/proj/Dockerfile")).toBe("shell");
    expect(languageForPath(".gitignore")).toBe("shell");
  });

  it("returns plain for unknown or binary-ish names", () => {
    expect(languageForPath("notes")).toBe("plain");
    expect(languageForPath("archive.bin")).toBe("plain");
  });
});

describe("highlight", () => {
  it("returns null for plain language and oversized input", () => {
    expect(highlight("anything", "plain")).toBeNull();
    expect(highlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "js")).toBeNull();
  });

  it("wraps keywords, strings, comments, and numbers in token spans", () => {
    const html = highlight('const x = 42; // hi\nconst s = "hello";', "js")!;
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    expect(html).toContain('<span class="tok-comment">// hi</span>');
    expect(html).toContain('<span class="tok-string">&quot;hello&quot;</span>');
  });

  it("colours function calls and capitalised types", () => {
    const html = highlight("foo(Bar)", "js")!;
    expect(html).toContain('<span class="tok-func">foo</span>');
    expect(html).toContain('<span class="tok-type">Bar</span>');
  });

  it("treats JSON object keys as props, not strings", () => {
    const html = highlight('{ "name": "eldrun" }', "json")!;
    expect(html).toContain('<span class="tok-prop">&quot;name&quot;</span>');
    expect(html).toContain('<span class="tok-string">&quot;eldrun&quot;</span>');
  });

  it("escapes HTML so source can never inject markup", () => {
    const html = highlight("x = '<img src=x onerror=alert(1)>'", "js")!;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("highlights markup tags, attributes, and comments", () => {
    const html = highlight('<!-- c --><a href="x">t</a>', "markup")!;
    expect(html).toContain('<span class="tok-comment">&lt;!-- c --&gt;</span>');
    expect(html).toContain('<span class="tok-tag">a</span>');
    expect(html).toContain('<span class="tok-attr">href</span>');
    expect(html).toContain('<span class="tok-string">&quot;x&quot;</span>');
  });

  it("highlights TeX commands, comments, and environment names", () => {
    const html = highlight("\\section{Intro} % note\n\\begin{itemize}", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\section</span>');
    expect(html).toContain('<span class="tok-comment">% note</span>');
    expect(html).toContain('<span class="tok-keyword">\\begin</span>');
    expect(html).toContain('<span class="tok-type">itemize</span>');
  });

  it("treats an escaped percent as a command, not a comment", () => {
    const html = highlight("50\\% done", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\%</span>');
    expect(html).not.toContain('tok-comment');
  });

  it("handles Python triple-quoted strings across newlines", () => {
    const html = highlight('x = """line1\nline2"""', "python")!;
    expect(html).toContain('<span class="tok-string">&quot;&quot;&quot;line1\nline2&quot;&quot;&quot;</span>');
  });

  it("highlights markdown headings, emphasis, code, and links", () => {
    const src = "# Title\n**bold** and *em* with `code`\n[text](http://x)";
    const html = highlight(src, "markdown")!;
    expect(html).toContain('<span class="tok-md-heading"># Title</span>');
    expect(html).toContain('<span class="tok-md-strong">**bold**</span>');
    expect(html).toContain('<span class="tok-md-em">*em*</span>');
    expect(html).toContain('<span class="tok-md-code">`code`</span>');
    expect(html).toContain('<span class="tok-md-link">text</span>');
    expect(html).toContain('<span class="tok-md-url">http://x</span>');
  });

  it("highlights markdown fences, blockquotes, and list markers", () => {
    const html = highlight("> quote\n- item\n```\nraw *not em*\n```", "markdown")!;
    expect(html).toContain('<span class="tok-md-quote">&gt; </span>');
    expect(html).toContain('<span class="tok-md-list">-</span>');
    expect(html).toContain('<span class="tok-md-code">```</span>');
    // Content inside a fence is verbatim, not inline-tokenized.
    expect(html).toContain('<span class="tok-md-code">raw *not em*</span>');
  });

  it("does not treat intra-word underscores or spaced asterisks as emphasis", () => {
    const html = highlight("some_var_name and 2 * 3 * 4", "markdown")!;
    expect(html).not.toContain("tok-md-em");
    expect(html).not.toContain("tok-md-strong");
  });
});
