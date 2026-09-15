/**
 * `lib/viewers/deck/icons.ts` — the deck's bundled icon library. Two things
 * shape it and both are pinned here: every glyph is path data in a 24×24 box
 * because that is the only vector form the PDF exporter can draw (no
 * `<circle>`, no groups, no sprite fetched at runtime), and the directional
 * arrows are ONE glyph plus a `rotate`, so a fix to the arrowhead fixes all four.
 * The rest covers the picker's pure helpers: labels resolved through i18n
 * (composed, not concatenated, for the rotated variants) and a substring search
 * ranked prefix → substring → alias.
 */
import { describe, expect, it } from "vitest";
import {
  ICON_CATEGORIES,
  ICON_VIEWBOX,
  ICONS,
  iconByKey,
  iconLabel,
  searchIcons,
} from "../lib/viewers/deck/icons";
import { translate, type TranslationKey } from "../lib/i18n";

const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate("en", key, vars);

/** Path data as SVG allows it: commands, numbers, separators — nothing else. */
const PATH_SYNTAX = /^[-MmLlHhVvCcSsQqTtAaZz0-9 .,]+$/;

describe("the library", () => {
  it("has a unique key for every icon, and iconByKey finds each one", () => {
    const keys = ICONS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of ICONS) expect(iconByKey(def.key)).toBe(def);
    expect(iconByKey("no-such-icon")).toBeUndefined();
  });

  it("every icon is pure path data — no elements, no markup, no external refs", () => {
    expect(ICON_VIEWBOX).toBe(24);
    for (const def of ICONS) {
      expect(def.paths.length, def.key).toBeGreaterThan(0);
      for (const path of def.paths) {
        expect(path, `${def.key}: ${path}`).toMatch(PATH_SYNTAX);
      }
    }
  });

  it("files every icon under a category the picker lists", () => {
    const ids = new Set(ICON_CATEGORIES.map((c) => c.id));
    for (const def of ICONS) expect(ids.has(def.category), def.key).toBe(true);
    // …and no category is empty, or the picker would show a blank tab.
    for (const cat of ICON_CATEGORIES) {
      expect(ICONS.some((i) => i.category === cat.id), cat.id).toBe(true);
    }
  });

  it("resolves every label and category name in English — no raw keys leak", () => {
    for (const def of ICONS) {
      expect(t(def.labelKey), def.key).not.toBe(def.labelKey);
      if (def.directionKey) expect(t(def.directionKey), def.key).not.toBe(def.directionKey);
    }
    for (const cat of ICON_CATEGORIES) expect(t(cat.labelKey)).not.toBe(cat.labelKey);
  });
});

describe("directional variants are derived, not hand-authored", () => {
  it("one arrow glyph serves four directions by rotation", () => {
    const right = iconByKey("arrow-right")!;
    const down = iconByKey("arrow-down")!;
    const left = iconByKey("arrow-left")!;
    const up = iconByKey("arrow-up")!;
    // Same path data on all four…
    for (const v of [down, left, up]) expect(v.paths).toEqual(right.paths);
    // …differing only in the quarter turns.
    expect(right.rotate).toBeUndefined(); // the base points right: no field at all
    expect(down.rotate).toBe(90);
    expect(left.rotate).toBe(180);
    expect(up.rotate).toBe(270);
    expect(iconByKey("arrow")).toBeUndefined(); // the base itself is not offered
  });

  it("chevrons get the same treatment, and the diagonal is a fifth arrow", () => {
    expect(["right", "down", "left", "up"].map((d) => iconByKey(`chevron-${d}`)?.rotate))
      .toEqual([undefined, 90, 180, 270]);
    const diagonal = iconByKey("arrow-up-right")!;
    expect(diagonal.rotate).toBe(315);
    expect(diagonal.paths).toEqual(iconByKey("arrow-right")!.paths);
    expect(diagonal.directionKey).toBeUndefined(); // it has its own label
  });

  it("a variant's label composes base + direction through i18n, not by concatenation", () => {
    expect(iconLabel(iconByKey("arrow-left")!, t)).toBe("Arrow left");
    // A translator whose grammar puts the direction first is honoured.
    const reversed = (key: TranslationKey, vars?: Record<string, string | number>) =>
      key === "deckIcon.directional" ? `${vars?.direction} ${vars?.icon}` : t(key, vars);
    expect(iconLabel(iconByKey("arrow-left")!, reversed)).toBe("left Arrow");
    // A plain icon's label is its own.
    expect(iconLabel(iconByKey("arrow-up-right")!, t)).toBe("Arrow up-right");
  });

  it("each variant carries its direction word as an alias, so `left` finds it", () => {
    expect(iconByKey("arrow-left")!.alias).toContain("left");
    expect(searchIcons("left", t).map((i) => i.key)).toContain("arrow-left");
  });
});

describe("searchIcons", () => {
  it("a blank query returns the whole pool, category-filtered when asked", () => {
    expect(searchIcons("", t)).toBe(ICONS);
    expect(searchIcons("   ", t, "people").every((i) => i.category === "people")).toBe(true);
    expect(searchIcons("", t, "people").length).toBeGreaterThan(0);
  });

  it("ranks a prefix hit above a substring hit above an alias hit", () => {
    const hits = searchIcons("arrow", t).map((i) => i.key);
    const rankOf = (key: string) => hits.indexOf(key);
    expect(rankOf("arrow-right")).toBeGreaterThanOrEqual(0);
    // "Double arrow" only contains the word; "Arrow" starts with it.
    expect(rankOf("arrow-right")).toBeLessThan(rankOf("arrow-both"));
  });

  it("matches on key and alias regardless of the on-screen language", () => {
    const german = (key: TranslationKey, vars?: Record<string, string | number>) => translate("de", key, vars);
    // `refresh` is an English key; its alias `reload` is technical and stays.
    expect(searchIcons("reload", german).map((i) => i.key)).toContain("refresh");
    expect(searchIcons("refresh", german).map((i) => i.key)).toContain("refresh");
  });

  it("is case-insensitive, trims, and finds nothing for a miss", () => {
    expect(searchIcons("  ARROW ", t).length).toBe(searchIcons("arrow", t).length);
    expect(searchIcons("zzzz-no-icon", t)).toEqual([]);
  });

  it("stays within the category when one is given", () => {
    const hits = searchIcons("a", t, "arrows");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((i) => i.category === "arrows")).toBe(true);
  });
});
