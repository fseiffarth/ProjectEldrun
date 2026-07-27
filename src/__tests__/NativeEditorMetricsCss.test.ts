/**
 * Regression lock for the "caret is left of the click, but only on some lines"
 * bug in the native code editor.
 *
 * The editor stacks a transparent <textarea> (owns the caret and the click →
 * offset hit-testing) over one or more syntax/decoration <pre> overlay layers
 * (own the glyphs the user actually sees). The caret only stays under the glyph
 * the user clicked if EVERY text-metric-affecting CSS property is byte-for-byte
 * identical across all layers — same font, same size, same line-height, same
 * tab-size, same kerning/ligature/precision settings, same padding origin.
 *
 * When they drift apart the caret and the glyphs diverge *content-dependently* —
 * e.g. a stray `tab-size: 2` on one layer only skews lines that contain tabs,
 * and different kerning skews only lines with kerning pairs. That is exactly the
 * "only some lines" symptom, and it keeps reappearing because these parallel CSS
 * rules are edited independently.
 *
 * This test parses `themes.css` and asserts the effective metric set of the
 * <textarea> equals that of the highlight layer AND every decoration overlay, so
 * any future edit that desyncs one layer fails here instead of in the user's eye.
 */
import { describe, it, expect } from "vitest";
// Read the stylesheet at test time. A `?raw` import yields "" under the config's
// `css: false`, so go through node's fs instead. The project has no @types/node,
// so tsc can't see the builtin — suppress just that resolution error; vitest
// resolves it fine at runtime. Vitest runs from the repo root → repo-relative path.
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";

const CSS: string = readFileSync("src/styles/themes.css", "utf8");

type Decls = Record<string, string>;
interface Rule {
  selectors: string[];
  decls: Decls;
}

/** Parse every innermost rule (a selector list + its flat declaration block).
 *  Declaration bodies never contain braces, so the innermost-match regex skips
 *  @media wrappers cleanly — good enough for the top-level editor rules here. */
function parseRules(css: string): Rule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(noComments); m; m = re.exec(noComments)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const decls: Decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim().toLowerCase();
      const val = d
        .slice(i + 1)
        .trim()
        .replace(/\s+/g, " ");
      if (prop) decls[prop] = val;
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

const RULES = parseRules(CSS);

/** The merged declarations of every rule that targets `selector` exactly (as a
 *  whole selector-list member), in source order (later wins). */
function declsFor(selector: string): Decls {
  const out: Decls = {};
  for (const r of RULES) if (r.selectors.includes(selector)) Object.assign(out, r.decls);
  return out;
}

// The <textarea>'s effective style is `.file-viewer-editor` (base) overridden by
// `.file-viewer-code-editor` (equal specificity, later in source → wins).
const TEXTAREA: Decls = {
  ...declsFor(".file-viewer-editor"),
  ...declsFor(".file-viewer-code-editor"),
};

// The layers that must line up glyph-for-glyph under the caret.
const OVERLAY_SELECTORS = [
  ".file-viewer-highlight",
  ".file-viewer-link-layer",
  ".file-viewer-search-layer",
  ".file-viewer-change-layer",
  ".file-viewer-delete-layer",
  ".file-viewer-grammar-layer",
  ".file-viewer-ghost",
];

// Every property that moves a glyph horizontally or vertically. If any of these
// differs between the caret layer and a glyph layer, the caret drifts off the
// text (globally, or on just the lines that trigger that property).
const METRIC_PROPS = [
  "font-family",
  "font-size",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "white-space",
  "font-variant-ligatures",
  "font-feature-settings",
  "font-kerning",
  "text-rendering",
  "padding",
];

describe("native editor layer metric parity (themes.css)", () => {
  it("the CSS actually defines the editor + overlay rules (guards against a silent rename)", () => {
    // Without this, a renamed class would make declsFor return {} and the parity
    // assertions below would vacuously pass.
    expect(Object.keys(declsFor(".file-viewer-editor")).length).toBeGreaterThan(0);
    expect(TEXTAREA["line-height"]).toBeTruthy();
    expect(TEXTAREA["font-size"]).toBeTruthy();
    for (const sel of OVERLAY_SELECTORS) {
      const d = declsFor(sel);
      expect(d["line-height"], `${sel} missing line-height`).toBeTruthy();
      expect(d["font-size"], `${sel} missing font-size`).toBeTruthy();
    }
  });

  it("the <textarea> resolves to the canonical editor metrics", () => {
    // Pin the exact effective values so a change that moves BOTH layers together
    // to something wrong (e.g. re-enabling kerning everywhere) is still caught.
    expect(TEXTAREA["font-size"]).toBe("var(--code-font-size, 12px)");
    expect(TEXTAREA["line-height"]).toBe("var(--code-line-height, 18px)");
    expect(TEXTAREA["white-space"]).toBe("pre");
    expect(TEXTAREA["tab-size"]).toBe("4"); // NOT the base rule's 2 — it must be overridden
    expect(TEXTAREA["font-variant-ligatures"]).toBe("none");
    expect(TEXTAREA["font-kerning"]).toBe("none");
    expect(TEXTAREA["text-rendering"]).toBe("geometricPrecision");
    expect(TEXTAREA["padding"]).toBe("10px 12px");
  });

  for (const sel of OVERLAY_SELECTORS) {
    it(`${sel} shares every glyph-metric property with the <textarea>`, () => {
      const overlay = declsFor(sel);
      for (const prop of METRIC_PROPS) {
        expect(
          overlay[prop],
          `${sel} "${prop}" (${overlay[prop]}) must equal the textarea's (${TEXTAREA[prop]}) or the caret drifts off the glyphs`,
        ).toBe(TEXTAREA[prop]);
      }
    });
  }

  it("no layer sets letter-spacing or word-spacing (any value would desync advances)", () => {
    // These default to `normal` everywhere; asserting they are UNSET keeps a
    // future one-layer tweak from silently reintroducing per-line drift.
    expect(TEXTAREA["letter-spacing"]).toBeUndefined();
    expect(TEXTAREA["word-spacing"]).toBeUndefined();
    for (const sel of OVERLAY_SELECTORS) {
      expect(declsFor(sel)["letter-spacing"]).toBeUndefined();
      expect(declsFor(sel)["word-spacing"]).toBeUndefined();
    }
  });
});
