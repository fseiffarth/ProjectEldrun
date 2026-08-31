/**
 * The Theme Customizer's contract with the document (`stores/settings`'s
 * `normalizeThemeVars`/`applyThemeVars`, `lib/themeTokens`).
 *
 * The rules worth pinning are the ones whose failure is silent. A token name
 * outside the catalog must never reach the root style (`ui_theme_vars` is
 * written as inline custom properties, so an unvalidated pair from a
 * hand-edited settings.json is an arbitrary-CSS write). An invalid *value*
 * must never reach it either — every rule reading that token would drop.
 * `--accent` must stay out of the map, since it has its own setting and two
 * writers for one color is two sources of truth. Clearing an override must
 * really clear it: inline root vars outrank every `[data-theme]` block, so a
 * leftover shadows all themes with no UI left pointing at it. Every catalog
 * name must exist in the stylesheet, or the panel offers a knob wired to
 * nothing. And the pre-paint cache holds only what was validated.
 *
 * A saved theme (`normalizeThemePresets`) is the same map plus an accent, a
 * base theme and a corner style, sitting in the same hand-editable file — and
 * it reaches the root style the moment somebody presses Load, so it is
 * validated on READ, not merely on write. The used-color strip is derived from
 * the painted palette and must stay a deduplicated view of it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

import {
  applyThemeVars,
  normalizeThemePresets,
  normalizeThemeVars,
  THEME_PRESET_LIMIT,
  THEME_PRESET_NAME_MAX,
} from "../stores/settings";
import {
  THEME_TOKENS,
  THEME_VAR_NAMES,
  themeTokenExampleKey,
} from "../lib/themeTokens";
import { en } from "../lib/i18n";
import {
  cssColorToHex,
  paletteFromColors,
} from "../components/layout/ThemeCustomizer";
import { readAppStylesheet } from "./cssCorpus";

const rootStyle = () => document.documentElement.style;

beforeEach(() => {
  localStorage.clear();
  applyThemeVars(null);
});

describe("normalizeThemeVars", () => {
  it("keeps catalog tokens holding a hex color, trimmed and lowercased", () => {
    expect(normalizeThemeVars({ "--bg-panel": "  #1A2B3C " })).toEqual({
      "--bg-panel": "#1a2b3c",
    });
  });

  it("keeps the 8-digit form, so a translucent token stays translucent", () => {
    expect(normalizeThemeVars({ "--bg-hover": "#ffffff26" })).toEqual({
      "--bg-hover": "#ffffff26",
    });
  });

  it("drops a name outside the catalog", () => {
    expect(normalizeThemeVars({ "--not-a-token": "#ffffff" })).toEqual({});
  });

  it("drops --accent: it has its own setting", () => {
    expect(THEME_VAR_NAMES.has("--accent")).toBe(false);
    expect(normalizeThemeVars({ "--accent": "#ff0000" })).toEqual({});
  });

  it("drops anything that is not a full hex color", () => {
    expect(
      normalizeThemeVars({
        "--bg-main": "red",
        "--bg-panel": "#abc",
        "--text-primary": "",
        "--border-color": "var(--accent)",
      }),
    ).toEqual({});
  });

  it("survives junk without throwing", () => {
    expect(normalizeThemeVars(null)).toEqual({});
    expect(normalizeThemeVars(undefined)).toEqual({});
    expect(
      normalizeThemeVars({ "--bg-main": 3 as unknown as string }),
    ).toEqual({});
  });
});

describe("applyThemeVars", () => {
  it("writes an override onto the root style", () => {
    applyThemeVars({ "--bg-panel": "#101820" });
    expect(rootStyle().getPropertyValue("--bg-panel")).toBe("#101820");
  });

  it("removes a token dropped from the map", () => {
    applyThemeVars({ "--bg-panel": "#101820", "--bg-main": "#000102" });
    applyThemeVars({ "--bg-main": "#000102" });
    expect(rootStyle().getPropertyValue("--bg-panel")).toBe("");
    expect(rootStyle().getPropertyValue("--bg-main")).toBe("#000102");
  });

  it("clears everything on an empty map", () => {
    applyThemeVars({ "--bg-panel": "#101820" });
    applyThemeVars({});
    expect(rootStyle().getPropertyValue("--bg-panel")).toBe("");
  });

  it("never writes a value it would not store", () => {
    applyThemeVars({ "--bg-panel": "red", "--not-a-token": "#ffffff" });
    expect(rootStyle().getPropertyValue("--bg-panel")).toBe("");
    expect(rootStyle().getPropertyValue("--not-a-token")).toBe("");
  });

  it("caches only the validated map for the pre-paint script", () => {
    applyThemeVars({ "--bg-panel": "#101820", "--bogus": "#fff" });
    expect(JSON.parse(localStorage.getItem("eldrun-theme-vars") ?? "{}")).toEqual({
      "--bg-panel": "#101820",
    });
    applyThemeVars({});
    expect(localStorage.getItem("eldrun-theme-vars")).toBeNull();
  });
});

describe("the token catalog", () => {
  it("offers no knob the stylesheet does not declare", () => {
    const css = readAppStylesheet();
    const missing = THEME_TOKENS.flatMap((tk) => [tk.name, tk.probe])
      .filter((name): name is string => typeof name === "string")
      .filter((name) => !css.includes(`${name}:`));
    expect(missing).toEqual([]);
  });

  it("gives every token an example of what it paints", () => {
    // The example is keyed off the name, so a token added without its string
    // renders the raw key. English holds the full key set by definition.
    const dict = en as Record<string, string>;
    const missing = THEME_TOKENS.map((tk) => themeTokenExampleKey(tk.name)).filter(
      (key) => typeof dict[key] !== "string",
    );
    expect(missing).toEqual([]);
  });

  it("lists every token once", () => {
    const names = THEME_TOKENS.map((tk) => tk.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("cssColorToHex", () => {
  it("reads the computed forms an engine hands back", () => {
    expect(cssColorToHex("rgb(16, 24, 32)")).toBe("#101820");
    expect(cssColorToHex("rgb(16 24 32)")).toBe("#101820");
    expect(cssColorToHex("rgba(16, 24, 32, 0.5)")).toBe("#10182080");
    expect(cssColorToHex("rgb(16 24 32 / 0.5)")).toBe("#10182080");
  });

  it("drops the alpha channel when the color is opaque", () => {
    expect(cssColorToHex("rgba(255, 255, 255, 1)")).toBe("#ffffff");
  });

  it("returns null for anything that is not a resolved color", () => {
    expect(cssColorToHex("transparent")).toBeNull();
    expect(cssColorToHex("linear-gradient(90deg, #000, #fff)")).toBeNull();
    expect(cssColorToHex("")).toBeNull();
  });
});

describe("normalizeThemePresets", () => {
  const preset = (extra: Record<string, unknown> = {}) => ({
    id: "p1",
    name: "Mine",
    vars: { "--bg-panel": "#101820" },
    ...extra,
  });

  it("keeps an id, a name and a validated var map", () => {
    expect(normalizeThemePresets([preset()])).toEqual([
      { id: "p1", name: "Mine", vars: { "--bg-panel": "#101820" } },
    ]);
  });

  it("validates the vars the way ui_theme_vars is validated", () => {
    const [p] = normalizeThemePresets([
      preset({ vars: { "--bg-panel": "red", "--not-a-token": "#ffffff", "--bg-main": "#000102" } }),
    ]);
    expect(p.vars).toEqual({ "--bg-main": "#000102" });
  });

  it("keeps the base theme, accent and corners a look was saved with", () => {
    const [p] = normalizeThemePresets([
      preset({ theme: "soft_dark", accent: " #FF00AA ", corners: "rounded", saved: 12 }),
    ]);
    expect(p).toEqual({
      id: "p1",
      name: "Mine",
      theme: "soft_dark",
      accent: "#ff00aa",
      corners: "rounded",
      saved: 12,
      vars: { "--bg-panel": "#101820" },
    });
  });

  it("drops a theme, accent or corner value it does not recognise", () => {
    const [p] = normalizeThemePresets([
      preset({ theme: "not_a_theme", accent: "hotpink", corners: "circle" }),
    ]);
    expect(p.theme).toBeUndefined();
    expect(p.accent).toBeUndefined();
    expect(p.corners).toBeUndefined();
  });

  it("drops entries with no id or no name, and duplicate ids", () => {
    expect(
      normalizeThemePresets([
        preset({ id: "  " }),
        preset({ name: "  " }),
        preset(),
        preset({ name: "Second" }),
      ]),
    ).toEqual([{ id: "p1", name: "Mine", vars: { "--bg-panel": "#101820" } }]);
  });

  it("caps the name and the list", () => {
    const [long] = normalizeThemePresets([preset({ name: "x".repeat(200) })]);
    expect(long.name.length).toBe(THEME_PRESET_NAME_MAX);
    const many = Array.from({ length: THEME_PRESET_LIMIT + 5 }, (_, i) =>
      preset({ id: `p${i}` }),
    );
    expect(normalizeThemePresets(many).length).toBe(THEME_PRESET_LIMIT);
  });

  it("survives junk without throwing", () => {
    expect(normalizeThemePresets(undefined)).toEqual([]);
    expect(normalizeThemePresets(null)).toEqual([]);
    expect(normalizeThemePresets("nope")).toEqual([]);
    expect(normalizeThemePresets([null, 3, "x", {}])).toEqual([]);
    expect(normalizeThemePresets([preset({ vars: "nope" })])).toEqual([
      { id: "p1", name: "Mine", vars: {} },
    ]);
  });
});

describe("paletteFromColors", () => {
  const tokens = [
    { name: "--a" },
    { name: "--b" },
    { name: "--c" },
    { name: "--d" },
  ];

  it("lists each distinct color once, in catalog order, with its tokens", () => {
    expect(
      paletteFromColors({ "--a": "#111111", "--b": "#222222", "--c": "#111111" }, tokens),
    ).toEqual([
      { hex: "#111111", tokens: ["--a", "--c"] },
      { hex: "#222222", tokens: ["--b"] },
    ]);
  });

  it("skips a token the readback could not resolve", () => {
    expect(paletteFromColors({ "--a": "#111111" }, tokens)).toEqual([
      { hex: "#111111", tokens: ["--a"] },
    ]);
  });
});
