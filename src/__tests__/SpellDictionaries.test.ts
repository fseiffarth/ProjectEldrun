/**
 * The dictionary picker's pure half (M#248): Hunspell stems → Intl tags,
 * display names in the UI language, and the installed/downloadable split.
 */
import { describe, it, expect } from "vitest";
import {
  hunspellToBcp47,
  languageDisplayName,
  dictionaryLabel,
  defaultSpellLanguage,
  dictionaryChoices,
} from "../lib/spellDictionaries";

describe("hunspellToBcp47", () => {
  it("swaps the underscore for a hyphen and leaves tagged codes alone", () => {
    expect(hunspellToBcp47("de_DE")).toBe("de-DE");
    expect(hunspellToBcp47("sr-Latn")).toBe("sr-Latn");
    expect(hunspellToBcp47("eo")).toBe("eo");
  });
});

describe("languageDisplayName / dictionaryLabel", () => {
  it("names a language in the UI language and keeps the code beside it", () => {
    expect(languageDisplayName("de_DE", "en")).toMatch(/^German/);
    expect(languageDisplayName("de_DE", "de")).toMatch(/^Deutsch/);
    expect(dictionaryLabel("en_GB", "en")).toBe(
      `${languageDisplayName("en_GB", "en")} · en_GB`,
    );
  });

  it("falls back to the bare code when there is no name for it", () => {
    // Not a language tag at all — Intl either throws or echoes it back.
    expect(languageDisplayName("zz_ZZ_bogus_tag", "en")).toBe("zz_ZZ_bogus_tag");
    expect(dictionaryLabel("zz_ZZ_bogus_tag", "en")).toBe("zz_ZZ_bogus_tag");
  });
});

describe("defaultSpellLanguage", () => {
  it("prefers an English variant, else the first, else nothing", () => {
    expect(defaultSpellLanguage([{ code: "de_DE" }, { code: "en_GB" }])).toBe("en_GB");
    expect(defaultSpellLanguage([{ code: "de_DE" }, { code: "fr_FR" }])).toBe("de_DE");
    expect(defaultSpellLanguage([])).toBe("");
  });
});

describe("dictionaryChoices", () => {
  const installed = [
    { code: "en_US", removable: false },
    { code: "de_DE", removable: true },
  ];
  const catalog = [
    { code: "de_DE", source: "de" },
    { code: "fr_FR", source: "fr" },
    { code: "en_US", source: "en" },
    { code: "it_IT", source: "it" },
  ];

  it("splits installed from downloadable and never offers an installed code twice", () => {
    const { installed: have, downloadable } = dictionaryChoices(installed, catalog, "en");
    expect(have.map((d) => d.code).sort()).toEqual(["de_DE", "en_US"]);
    expect(downloadable.map((d) => d.code).sort()).toEqual(["fr_FR", "it_IT"]);
    expect(have.find((d) => d.code === "de_DE")?.removable).toBe(true);
    expect(have.find((d) => d.code === "en_US")?.removable).toBe(false);
  });

  it("sorts both lists by display label", () => {
    const { downloadable } = dictionaryChoices([], catalog, "en");
    const labels = downloadable.map((d) => d.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en")));
    // English names: English, French, German, Italian.
    expect(downloadable.map((d) => d.code)).toEqual(["en_US", "fr_FR", "de_DE", "it_IT"]);
  });
});
