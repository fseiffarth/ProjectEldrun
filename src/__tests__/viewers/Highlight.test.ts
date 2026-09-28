import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, highlight, languageForPath } from "../../lib/viewers/highlight";

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
  it("returns null for oversized input, plain text included", () => {
    expect(highlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "js")).toBeNull();
    expect(highlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "plain")).toBeNull();
  });

  it("leaves prose in plain text untouched but escaped", () => {
    expect(highlight("just <words> here", "plain")).toBe("just &lt;words&gt; here");
  });

  it("marks plain-text structure: headings, rules, bullets, keys", () => {
    const html = highlight("Title\n=====\n# Notes\n- item 3\nname: Ada", "plain")!;
    expect(html).toContain('<span class="tok-txt-heading">Title</span>');
    expect(html).toContain('<span class="tok-txt-rule">=====</span>');
    expect(html).toContain('<span class="tok-txt-heading"># Notes</span>');
    expect(html).toContain('<span class="tok-txt-list">-</span> item <span class="tok-txt-num">3</span>');
    expect(html).toContain('<span class="tok-txt-key">name</span>: Ada');
  });

  it("marks plain-text inline tokens: urls, dates, quotes, levels, numbers", () => {
    const html = highlight(
      'ERROR 2024-05-01 12:30 see https://x.org/a "quoted" TODO 42% WARN a@b.io',
      "plain",
    )!;
    expect(html).toContain('<span class="tok-txt-bad">ERROR</span>');
    expect(html).toContain('<span class="tok-txt-date">2024-05-01 12:30</span>');
    expect(html).toContain('<span class="tok-txt-url">https://x.org/a</span>');
    expect(html).toContain('<span class="tok-txt-string">&quot;quoted&quot;</span>');
    expect(html).toContain('<span class="tok-txt-marker">TODO</span>');
    expect(html).toContain('<span class="tok-txt-num">42%</span>');
    expect(html).toContain('<span class="tok-txt-warn">WARN</span>');
    expect(html).toContain('<span class="tok-txt-url">a@b.io</span>');
  });

  it("does not colour digits inside a word", () => {
    expect(highlight("v1.2 abc123", "plain")).toBe("v1.2 abc123");
  });

  it("stays fast on one huge line with unclosed quotes and at-less words", () => {
    const line = ('"' + "a".repeat(50)).repeat(3000);
    const t0 = performance.now();
    expect(highlight(line, "plain")).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
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
    expect(html).toContain('<span class="tok-keyword tok-section">\\section</span>');
    expect(html).toContain('<span class="tok-comment">% note</span>');
    expect(html).toContain('<span class="tok-keyword">\\begin</span>');
    expect(html).toContain('<span class="tok-type">itemize</span>');
  });

  it("greys a whole \\begin{comment} block, delimiters included", () => {
    const html = highlight(
      "\\begin{comment}\n\\section{Dropped}\n\\end{comment}\n\\section{Kept}",
      "tex",
    )!;
    expect(html).toContain(
      '<span class="tok-comment">\\begin{comment}\n\\section{Dropped}\n\\end{comment}</span>',
    );
    // Nothing inside is tokenized; the section AFTER the block still is.
    expect(html).not.toContain('<span class="tok-arg">Dropped</span>');
    expect(html).toContain('<span class="tok-arg">Kept</span>');
  });

  it("greys an unclosed comment block to the end of the file", () => {
    const html = highlight("a\n\\begin{comment}\n\\section{x}", "tex")!;
    expect(html).toBe('a\n<span class="tok-comment">\\begin{comment}\n\\section{x}</span>');
  });

  it("colours other environments as before — only `comment` greys out", () => {
    const html = highlight("\\begin{itemize}\n\\item a\n\\end{itemize}", "tex")!;
    expect(html).toContain('<span class="tok-type">itemize</span>');
    expect(html).not.toContain("tok-comment");
  });

  it("colours a beamer overlay spec glued to a command as its own token", () => {
    const html = highlight("\\only<2->{x} \\item<3> y \\begin{frame}<1->", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\only</span><span class="tok-overlay">&lt;2-&gt;</span>');
    expect(html).toContain('<span class="tok-keyword">\\item</span><span class="tok-overlay">&lt;3&gt;</span>');
    expect(html).toContain('<span class="tok-type">frame</span>}<span class="tok-overlay">&lt;1-&gt;</span>');
    // The argument after the spec still highlights as one.
    expect(html).toContain('<span class="tok-arg">x</span>');
  });

  it("leaves a `<` that is prose or math alone", () => {
    const html = highlight("$a<b$ \\vec<a> and \\only <2>", "tex")!;
    expect(html).not.toContain("tok-overlay");
  });

  it("treats an escaped percent as a command, not a comment", () => {
    const html = highlight("50\\% done", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\%</span>');
    expect(html).not.toContain('tok-comment');
  });

  it("renders a TeX command's brace argument italic, braces excluded", () => {
    const html = highlight("\\emph{Intro}", "tex")!;
    expect(html).toBe(
      '<span class="tok-keyword">\\emph</span>{<span class="tok-arg">Intro</span>}',
    );
  });

  it("tags a sectioning command so its title can read as a heading", () => {
    const html = highlight("\\section{Intro}", "tex")!;
    expect(html).toBe(
      '<span class="tok-keyword tok-section">\\section</span>{<span class="tok-arg">Intro</span>}',
    );
  });

  it("wraps TeX math in one token and keeps tokenizing inside it", () => {
    const html = highlight("a $\\frac{1}{2}$ b", "tex")!;
    expect(html).toContain('<span class="tok-math">$<span class="tok-keyword">\\frac</span>');
    expect(html).toContain('<span class="tok-num">1</span>');
    expect(html).toContain("$</span> b");
    expect(highlight("$$x$$", "tex")).toBe('<span class="tok-math">$$x$$</span>');
    expect(highlight("\\[x\\]", "tex")).toBe('<span class="tok-math">\\[x\\]</span>');
    expect(highlight("\\(x\\)", "tex")).toBe('<span class="tok-math">\\(x\\)</span>');
  });

  it("leaves an unclosed or paragraph-spanning dollar plain", () => {
    expect(highlight("costs $5\n\nlater $x", "tex")).not.toContain("tok-math");
    expect(highlight("\\$5 and \\$6", "tex")).not.toContain("tok-math");
    expect(highlight("$a % $ in a comment\nb$", "tex")).toContain(
      '<span class="tok-comment">% $ in a comment</span>',
    );
  });

  it("takes every argument of a multi-argument command, and past an optional one", () => {
    const frac = highlight("\\frac{a}{b}", "tex")!;
    expect(frac).toContain('<span class="tok-arg">a</span>');
    expect(frac).toContain('<span class="tok-arg">b</span>');
    const graphic = highlight("\\includegraphics[width=2cm]{fig.png}", "tex")!;
    expect(graphic).toContain("[width=2cm]");
    expect(graphic).toContain('<span class="tok-arg">fig.png</span>');
  });

  it("keeps tokenizing inside an argument, so a nested command still colours", () => {
    const html = highlight("\\textbf{see \\ref{fig:x} and 42}", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\ref</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    // The nested \ref's own argument is italic in its own right (nesting spans).
    expect(html).toContain('<span class="tok-arg">fig:x</span>');
  });

  it("leaves the environment name as a type and a single-char sequence argumentless", () => {
    const env = highlight("\\begin{itemize}", "tex")!;
    expect(env).toContain('<span class="tok-type">itemize</span>');
    expect(env).not.toContain("tok-arg");
    // `\{` is a literal brace; what follows it is text, not its argument.
    expect(highlight("\\{x}", "tex")!).not.toContain("tok-arg");
  });

  it("leaves an unbalanced argument alone", () => {
    const html = highlight("\\emph{unclosed", "tex")!;
    expect(html).not.toContain("tok-arg");
    expect(html).toContain('<span class="tok-keyword">\\emph</span>');
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
