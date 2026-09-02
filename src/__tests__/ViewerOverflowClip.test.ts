/**
 * Regression lock for "the viewer is displaced / cut off at one edge until a
 * resize" (the corruption a TeX recompile's forward search first surfaced in
 * the synced PDF viewer).
 *
 * An `overflow: hidden` box is still a SCROLL CONTAINER: `scrollIntoView`, a
 * `focus()` reveal, and selection auto-scroll all scroll it programmatically,
 * and it shows no scrollbar to drag the content back with — so one stray call
 * anywhere in the chain shifts a whole pane sideways and nothing short of a
 * resize puts it back. `scrollBox.ts` fixed the viewer's own `scrollIntoView`
 * calls, but that closed one caller, not the class: any future focus() or
 * scroll in a viewer re-opens it.
 *
 * `overflow: clip` closes the class — a clipped box is NOT a scroll container,
 * so nothing can displace it, ever. Every pure-clipping wrapper between a
 * viewer's real scroller and the window root must therefore declare BOTH:
 * `overflow: hidden` first (the fallback — an engine without `clip` support
 * would otherwise drop the invalid value and leave the box `visible`), then
 * `overflow: clip` to win the cascade where supported.
 *
 * The list below is the ancestor chain of the file viewers (main window,
 * popout, docked subwindow column, TeX workspace). A wrapper that is meant to
 * scroll (like `.file-viewer-pdf-scroll`) must NOT be added here.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "./cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** The clipping wrappers above every file viewer, root to leaf. */
const CLIP_WRAPPERS = [
  "html",
  ".center-panel",
  ".detached-body",
  ".center-pane",
  ".subwindow-files",
  ".file-viewer",
  ".tex-workspace",
  ".tex-workspace-center",
];

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule (selector list + its raw declaration block). */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    rules.push({ selectors, body: m[2] });
  }
  return rules;
}

const rules = parseRules(CSS);

describe("viewer clipping wrappers are not scroll containers", () => {
  it.each(CLIP_WRAPPERS)("%s declares overflow: hidden then overflow: clip", (sel) => {
    // The bare selector's own rule(s), not compounds like `.center-panel.dragging
    // .center-pane` — the base declaration is where the overflow lives.
    const own = rules.filter((r) => r.selectors.includes(sel));
    expect(own.length, `no rule found for bare selector ${sel}`).toBeGreaterThan(0);
    const withOverflow = own.filter((r) => /\boverflow\s*:/.test(r.body));
    expect(
      withOverflow.length,
      `${sel} declares no overflow at all — if the wrapper was removed, drop it from CLIP_WRAPPERS`,
    ).toBeGreaterThan(0);
    for (const r of withOverflow) {
      const hidden = r.body.search(/overflow\s*:\s*hidden/);
      const clip = r.body.search(/overflow\s*:\s*clip/);
      expect(hidden, `${sel}: missing the overflow: hidden fallback`).toBeGreaterThanOrEqual(0);
      expect(clip, `${sel}: missing overflow: clip (the box is a scroll container again)`).toBeGreaterThanOrEqual(0);
      expect(clip, `${sel}: clip must come after hidden to win the cascade`).toBeGreaterThan(hidden);
    }
  });
});
