/**
 * Tests for the pure part of the viewer print pipeline (`lib/viewers/print`):
 * `buildPrintDoc` assembles a self-contained print document from a body + css.
 * The DOM driver (`printDocument`) and pdf.js rasteriser are exercised at
 * runtime, not here.
 */
import { describe, it, expect } from "vitest";
import { buildPrintDoc, TEXT_PRINT_CSS, MARKDOWN_PRINT_CSS } from "../lib/viewers/print";

describe("buildPrintDoc", () => {
  it("produces a complete, self-contained HTML document", () => {
    const doc = buildPrintDoc("<p>hi</p>", ".x{color:red}", "Note");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain("<body><p>hi</p></body>");
    // Caller CSS is inlined into the <style> after the print base.
    expect(doc).toContain(".x{color:red}");
    // Print base: page margins so nothing prints edge-to-edge.
    expect(doc).toContain("@page{margin:1.5cm}");
  });

  it("sets and escapes the document title", () => {
    const doc = buildPrintDoc("", "", 'a"b & <c>');
    expect(doc).toContain("<title>a&quot;b &amp; &lt;c></title>");
  });

  it("defaults the title when none is given", () => {
    expect(buildPrintDoc("", "")).toContain("<title>Print</title>");
  });

  it("does not escape the body (caller-trusted markup)", () => {
    // The body is already sanitised/escaped by the caller (renderMarkdown or
    // escapeHtml), so buildPrintDoc must pass it through verbatim.
    const doc = buildPrintDoc('<pre class="print-pre">a &lt; b</pre>', TEXT_PRINT_CSS);
    expect(doc).toContain('<pre class="print-pre">a &lt; b</pre>');
  });

  it("exposes stylesheets targeting the expected structures", () => {
    expect(MARKDOWN_PRINT_CSS).toContain(".markdown-body");
    expect(TEXT_PRINT_CSS).toContain("pre.print-pre");
  });
});
