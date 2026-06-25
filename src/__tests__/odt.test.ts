import { describe, it, expect } from "vitest";
import { extractOdt, renderOdtDocument } from "../lib/viewers/odt";

/** Wrap a body (and optional automatic-styles) in a minimal but namespace-correct
 *  ODF `content.xml`, so DOMParser accepts the prefixes the renderer reads. */
function odt(body: string, autoStyles = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <office:automatic-styles>${autoStyles}</office:automatic-styles>
  <office:body><office:text>${body}</office:text></office:body>
</office:document-content>`;
}

describe("renderOdtDocument — structure", () => {
  it("renders headings at their outline level and paragraphs", () => {
    const html = renderOdtDocument(
      odt(
        `<text:h text:outline-level="2">Title</text:h>` +
          `<text:p>Hello world</text:p>`,
      ),
    );
    expect(html).toBe(`<h2>Title</h2><p>Hello world</p>`);
  });

  it("clamps an out-of-range outline level into h1..h6", () => {
    const html = renderOdtDocument(odt(`<text:h text:outline-level="9">Deep</text:h>`));
    expect(html).toBe(`<h6>Deep</h6>`);
  });

  it("renders bullet and numbered lists from their list style", () => {
    const styles =
      `<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1"/></text:list-style>` +
      `<text:list-style style:name="L2"><text:list-level-style-number text:level="1"/></text:list-style>`;
    const bullet = renderOdtDocument(
      odt(
        `<text:list text:style-name="L1"><text:list-item><text:p>a</text:p></text:list-item>` +
          `<text:list-item><text:p>b</text:p></text:list-item></text:list>`,
        styles,
      ),
    );
    expect(bullet).toBe(`<ul><li>a</li><li>b</li></ul>`);

    const numbered = renderOdtDocument(
      odt(
        `<text:list text:style-name="L2"><text:list-item><text:p>a</text:p></text:list-item></text:list>`,
        styles,
      ),
    );
    expect(numbered).toBe(`<ol><li>a</li></ol>`);
  });

  it("renders a table as rows of cells", () => {
    const html = renderOdtDocument(
      odt(
        `<table:table><table:table-row>` +
          `<table:table-cell><text:p>a</text:p></table:table-cell>` +
          `<table:table-cell><text:p>b</text:p></table:table-cell>` +
          `</table:table-row></table:table>`,
      ),
    );
    expect(html).toBe(
      `<table class="odt-table"><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>`,
    );
  });
});

describe("renderOdtDocument — inline formatting", () => {
  it("applies bold/italic/underline from automatic text styles", () => {
    const styles =
      `<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>` +
      `<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid"/></style:style>`;
    const html = renderOdtDocument(
      odt(
        `<text:p><text:span text:style-name="T1">b</text:span>` +
          `<text:span text:style-name="T2">iu</text:span></text:p>`,
        styles,
      ),
    );
    expect(html).toBe(`<p><strong>b</strong><em><u>iu</u></em></p>`);
  });

  it("keeps safe hyperlinks and drops dangerous schemes", () => {
    const safe = renderOdtDocument(
      odt(`<text:p><text:a xlink:href="https://example.com">site</text:a></text:p>`),
    );
    expect(safe).toBe(
      `<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a></p>`,
    );
    const unsafe = renderOdtDocument(
      odt(`<text:p><text:a xlink:href="javascript:alert(1)">x</text:a></text:p>`),
    );
    // No anchor emitted for a javascript: URL — only the inner text survives.
    expect(unsafe).toBe(`<p>x</p>`);
  });

  it("expands explicit spaces and line breaks", () => {
    const html = renderOdtDocument(
      odt(`<text:p>a<text:s text:c="3"/>b<text:line-break/>c</text:p>`),
    );
    expect(html).toBe(`<p>a   b<br/>c</p>`);
  });

  it("renders an embedded image from the supplied data-URL map", () => {
    const images = new Map([["Pictures/1.png", "data:image/png;base64,AAAA"]]);
    const html = renderOdtDocument(
      odt(`<text:p><draw:frame><draw:image xlink:href="Pictures/1.png"/></draw:frame></text:p>`),
      { images },
    );
    expect(html).toBe(`<p><img class="odt-image" src="data:image/png;base64,AAAA" alt="" /></p>`);
  });
});

describe("renderOdtDocument — security & errors", () => {
  it("HTML-escapes document text so markup can't be injected", () => {
    const html = renderOdtDocument(odt(`<text:p>&lt;script&gt;alert(1)&lt;/script&gt;</text:p>`));
    expect(html).toBe(`<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`);
    expect(html).not.toContain("<script>");
  });

  it("throws on XML without an ODF document body", () => {
    expect(() => renderOdtDocument("<root></root>")).toThrow();
  });
});

describe("extractOdt", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("decodes content.xml and maps Pictures/* to data URLs", () => {
    const { contentXml, images } = extractOdt({
      "content.xml": enc("<x/>"),
      "Pictures/img.png": new Uint8Array([1, 2, 3]),
      "styles.xml": enc("<y/>"),
    });
    expect(contentXml).toBe("<x/>");
    expect(images.get("Pictures/img.png")).toMatch(/^data:image\/png;base64,/);
    // Non-picture archive members are not exposed as images.
    expect(images.size).toBe(1);
  });

  it("throws when the archive has no content.xml", () => {
    expect(() => extractOdt({ "styles.xml": enc("<y/>") })).toThrow(/content\.xml/);
  });
});
