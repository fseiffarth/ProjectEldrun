/**
 * The inline placeholder scheme in `lib/viewers/markdown.ts`, which is where two
 * rendering bugs lived at once.
 *
 * A link label is rendered by recursing into `renderInline`, and by that point the
 * label already holds the pass's code/math/image placeholders. The recursion used
 * to start from empty stores, so the restore read past the end of an array and the
 * literal word "undefined" reached the page — which is what every badge line in
 * the README (`[![CI](img)](url)`) rendered as.
 *
 * The markers were also space-padded (` L0 `), so a document that merely *said*
 * "L0" collided with a live index and had that phrase replaced by someone else's
 * link. They are NUL-delimited now, and `renderMarkdown` strips NUL from the
 * source, so a marker cannot be forged from document text.
 *
 * These are rendering bugs, not escapes — the label path never stopped being
 * escape-first — so this file asserts both: the right output, and that nothing
 * live survives in it.
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../lib/viewers/markdown";

/** Parse rendered output and assert nothing executable survived: no script/iframe/
 *  object element, no `on*` handler attribute, no javascript: URL. Checking the
 *  parsed DOM rather than the HTML string is the point — `&lt;script&gt;` as text
 *  contains "script" but is inert, and a substring assertion cannot tell them
 *  apart in either direction. */
function expectInert(html: string) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    expect(["script", "iframe", "object", "embed", "style"]).not.toContain(
      el.tagName.toLowerCase(),
    );
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      if (["href", "src", "data-md-src"].includes(attr.name.toLowerCase())) {
        expect(attr.value.replace(/\s/g, "").toLowerCase()).not.toContain("javascript:");
      }
    }
  }
}

describe("markdown link labels", () => {
  it("renders an image inside a link label (the README badge lines)", () => {
    const html = renderMarkdown(
      "[![CI](https://img.shields.io/ci.svg)](https://example.com/ci)",
    );
    expect(html).not.toContain("undefined");
    expect(html).toContain('<img src="https://img.shields.io/ci.svg" alt="CI" />');
    expect(html).toContain('href="https://example.com/ci"');
    expectInert(html);
  });

  it("renders code spans and math inside a link label", () => {
    const code = renderMarkdown("[`npm run x` docs](https://example.com)");
    expect(code).not.toContain("undefined");
    expect(code).toContain("<code>npm run x</code>");

    const math = renderMarkdown("[see $x^2$ here](https://example.com)");
    expect(math).not.toContain("undefined");
    expect(math).toContain('class="md-math"');
  });

  it("renders a local image inside a link label", () => {
    const html = renderMarkdown("[![logo](src/assets/logo.svg)](./docs/readme.md)");
    expect(html).not.toContain("undefined");
    expect(html).toContain('data-md-src="src/assets/logo.svg"');
    expect(html).toContain('class="file-link"');
  });

  it("leaves placeholder-shaped prose alone, even beside a real link", () => {
    const html = renderMarkdown(
      "[real](https://example.com) and literally L0 and C0 and M0 here",
    );
    expect(html).not.toContain("undefined");
    // The prose survives verbatim; the link is emitted exactly once.
    expect(html).toContain("and literally L0 and C0 and M0 here");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("does not glue spaces around a link spliced into a word", () => {
    expect(renderMarkdown("foo[a](https://example.com)bar")).toContain(
      '>a</a>bar',
    );
    expect(renderMarkdown("foo[a](https://example.com)bar")).toContain("<p>foo<a ");
  });

  it("strips NUL from the source so a marker cannot be forged", () => {
    const forged = `x${String.fromCharCode(0)}L0${String.fromCharCode(0)}y [real](https://example.com)`;
    const html = renderMarkdown(forged);
    expect(html).not.toContain("undefined");
    expect(html).toContain("xL0y");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("keeps the label path escape-first under adversarial input", () => {
    const attacks = [
      "[<img src=x onerror=alert(1)>](https://e.com)",
      "[![<script>alert(1)</script>](https://e.com/a.svg)](https://e.com)",
      '[![x"onerror="alert(1)](https://e.com/a.svg)](https://e.com)',
      "[![x](javascript:alert(1))](https://e.com)",
      "[![x](https://e.com/a.svg)](javascript:alert(1))",
      "[` <script>alert(1)</script> `](https://e.com)",
      "[$<script>alert(1)</script>$](https://e.com)",
      "[<b>x</b>](https://e.com)",
      "[[[[[a](https://e.com)",
      "[![![a](https://e.com/1.svg)](https://e.com/2.svg)](https://e.com)",
    ];
    for (const src of attacks) {
      const html = renderMarkdown(src);
      expect(html, src).not.toContain("undefined");
      expectInert(html);
    }
  });
});
