/**
 * Regression lock for "a tab docked out of a popout arrives without its name".
 *
 * The window-blur rule pauses EVERY animation wholesale (`:root[data-blurred] *`
 * → `animation-play-state: paused`, typing-latency plan step 3). Its premise is
 * that a blurred window is one nobody is watching — which a CROSS-WINDOW tab
 * drop (#42) breaks: dragging a tab out of a popout and into the main window
 * ends with the pointer over a window the popout still holds focus away from, so
 * the destination is `[data-blurred]` at exactly the moment it has to show what
 * landed.
 *
 * Both drop-feedback animations open from nothing — `tab-drop-slot` from zero
 * width, `tab-land` (and its reduced-motion twin `tab-land-fade`) from
 * `opacity: 0` — so pausing them at 0% does not preserve a mid-state visual, it
 * renders the insertion slot invisible and the docked tab a blank gap holding
 * its place. The user's reading of that is "the tab is there but its name is
 * missing", and the name "comes back" on click purely because focusing the
 * window resumes the paused animation.
 *
 * So the two classes must be exempted from the pause, and the exemption must
 * outrank it. This asserts both halves against the whole stylesheet corpus.
 */
import { describe, it, expect } from "vitest";
import { readAppStylesheet } from "./cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  decls: Record<string, string>;
}

/** Every innermost rule (selector list + its flat declaration block). */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const decls: Record<string, string> = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim().toLowerCase();
      if (prop) decls[prop] = d.slice(i + 1).trim().replace(/\s+/g, " ");
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

const RULES = parseRules(CSS);

const playState = (selector: string): string | undefined => {
  let out: string | undefined;
  for (const r of RULES) {
    if (r.selectors.includes(selector) && r.decls["animation-play-state"]) {
      out = r.decls["animation-play-state"];
    }
  }
  return out;
};

describe("blurred-window animation pause — cross-window drop feedback (#42)", () => {
  it("still pauses animations wholesale on a blurred window", () => {
    // The exemption below is worth nothing if the rule it narrows is gone: that
    // would mean animations run everywhere and this test would pass vacuously.
    expect(playState(":root[data-blurred] *")).toMatch(/^paused/);
  });

  it("exempts the landed tab and the drop placeholder, with !important", () => {
    for (const sel of [
      ":root[data-blurred] .tab.landing",
      ":root[data-blurred] .tab-drop-placeholder",
    ]) {
      const value = playState(sel);
      expect(value, `${sel} must resume its animation while blurred`).toBeDefined();
      expect(value).toBe("running !important");
    }
  });

  it("keeps both drop-feedback animations opening from nothing", () => {
    // The reason the pause was destructive rather than merely frozen. If a
    // keyframe set ever stops starting from invisible, this lock can be relaxed
    // — but then it should be relaxed deliberately, not silently.
    const at0 = (name: string): string => {
      const m = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CSS);
      expect(m, `@keyframes ${name} not found`).not.toBeNull();
      return m![1];
    };
    expect(at0("tab-land")).toContain("opacity: 0");
    expect(at0("tab-land-fade")).toContain("opacity: 0");
    expect(at0("tab-drop-slot")).toContain("max-width: 0");
  });
});
