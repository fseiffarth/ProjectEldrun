/**
 * Regression lock for "Ctrl+wheel zoom stretches the page instead of enlarging
 * it": zoomed past the pane's width, the PDF grew taller while its width stayed
 * pinned to the pane, i.e. the page came out squashed.
 *
 * The cause is structural, not arithmetic. `PdfPageCanvas` sizes the canvas with
 * BOTH dimensions as inline pixel lengths (the page's own box × the zoom), so any
 * `max-width` in the cascade clamps one axis and leaves the other exactly where
 * the zoom put it — an aspect ratio nothing in the render path can restore. The
 * page stack is meant to grow past the viewport and scroll horizontally instead
 * (`.file-viewer-pdf-scroll` scrolls, `min-width: min-content` widens the stack
 * to the widest page), so there is no case where clamping a page to the pane is
 * the right answer.
 *
 * The overlays (text layer, links, search hits, remark markers) are positioned
 * against `.file-viewer-pdf-page-wrap`, so the same clamp on the wrap misplaces
 * every one of them on top of the squashed page — hence both are locked here.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "./cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    rules.push({
      selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean),
      body: m[2],
    });
  }
  return rules;
}

const rules = parseRules(CSS);

/** Every rule whose selector list mentions this element at all. */
const touching = (sel: string) =>
  rules.filter((r) => r.selectors.some((s) => s.includes(sel)));

describe("a zoomed PDF page keeps its aspect ratio", () => {
  it.each([".file-viewer-pdf-page", ".file-viewer-pdf-page-wrap"])(
    "%s is never clamped on one axis",
    (sel) => {
      const own = touching(sel);
      expect(own.length, `no rule found for ${sel}`).toBeGreaterThan(0);
      for (const r of own) {
        // `.file-viewer-pdf-page-gap` also starts with `.file-viewer-pdf-page`;
        // it is a divider, not the sheet, and may size itself freely.
        if (r.selectors.every((s) => s.includes("-page-gap"))) continue;
        expect(
          /\bmax-(width|height)\s*:/.test(r.body),
          `${r.selectors.join(", ")} clamps one axis of a page whose other axis ` +
            `is an inline pixel size — that is a stretched page, not a zoomed one`,
        ).toBe(false);
      }
    },
  );

  it("lets the stack widen to the zoomed page so it can scroll instead", () => {
    const stack = rules.filter((r) => r.selectors.includes(".file-viewer-pdf-pages"));
    expect(stack.length).toBeGreaterThan(0);
    expect(stack.some((r) => /min-width\s*:\s*min-content/.test(r.body))).toBe(true);
    const scroll = rules.filter((r) => r.selectors.includes(".file-viewer-pdf-scroll"));
    expect(scroll.some((r) => /overflow\s*:\s*auto/.test(r.body))).toBe(true);
  });
});
