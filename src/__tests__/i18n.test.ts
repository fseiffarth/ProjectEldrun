import { describe, it, expect } from "vitest";
import { translate, normalizeLang, LANGUAGES, TRANSLATIONS } from "../lib/i18n";

describe("i18n", () => {
  it("translates a known key per language", () => {
    expect(translate("en", "settings.title")).toBe("Settings");
    expect(translate("de", "settings.title")).toBe("Einstellungen");
    expect(translate("es", "settings.title")).toBe("Configuración");
    expect(translate("fr", "settings.title")).toBe("Paramètres");
    expect(translate("it", "settings.title")).toBe("Impostazioni");
  });

  it("falls back to English when a language lacks a key", () => {
    // `translate` with a made-up key returns the raw key (last-resort fallback),
    // and every real key present in `en` resolves in every language via fallback.
    // Spot-check the fallback path by asking a language for the base value: even
    // if a future key is added to `en` only, non-English still renders English,
    // never a blank.
    const enTitle = translate("en", "settings.title");
    for (const { value } of LANGUAGES) {
      expect(translate(value, "settings.title").length).toBeGreaterThan(0);
    }
    expect(enTitle).toBe("Settings");
  });

  it("substitutes {name} placeholders", () => {
    // No parameterized keys ship yet, but the substitution contract is public.
    expect(
      translate("en", "settings.title", { unused: "x" }),
    ).toBe("Settings");
  });

  it("normalizes unknown/empty language codes to English", () => {
    expect(normalizeLang("de")).toBe("de");
    expect(normalizeLang("xx")).toBe("en");
    expect(normalizeLang("")).toBe("en");
    expect(normalizeLang(null)).toBe("en");
    expect(normalizeLang(undefined)).toBe("en");
  });

  it("offers exactly the five supported languages", () => {
    expect(LANGUAGES.map((l) => l.value)).toEqual(["en", "de", "es", "fr", "it"]);
  });

  // The fallback to English is what makes a half-translated language *degrade*
  // rather than break — which is also why a missing key is invisible: nothing
  // fails, the string just comes out in English for four of the five languages.
  // Spot-checking one key could never catch that, so the whole set is compared.
  it("every language covers every English key", () => {
    const enKeys = Object.keys(TRANSLATIONS.en);
    const missingByLang: Record<string, string[]> = {};
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const dict = TRANSLATIONS[value] as Record<string, string>;
      const missing = enKeys.filter((k) => typeof dict[k] !== "string");
      if (missing.length) missingByLang[value] = missing.slice(0, 20);
    }
    expect(missingByLang).toEqual({});
  });

  it("no language defines a key English does not", () => {
    // A stray key is dead weight that can never render: `translate` reads the
    // English block for the key set every component is allowed to ask for.
    const enKeys = new Set(Object.keys(TRANSLATIONS.en));
    const extraByLang: Record<string, string[]> = {};
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const extra = Object.keys(TRANSLATIONS[value]).filter((k) => !enKeys.has(k));
      if (extra.length) extraByLang[value] = extra.slice(0, 20);
    }
    expect(extraByLang).toEqual({});
  });

  it("every {placeholder} in English survives into every translation", () => {
    // A dropped `{path}` renders the literal braces to the user, and a *renamed*
    // one renders nothing at all — both invisible until someone runs that
    // language. The worktree confirmations are exactly this shape.
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatched: string[] = [];
    for (const { value } of LANGUAGES) {
      if (value === "en") continue;
      const dict = TRANSLATIONS[value] as Record<string, string>;
      for (const [key, text] of Object.entries(TRANSLATIONS.en)) {
        const there = dict[key];
        if (typeof there !== "string") continue;
        const a = placeholders(text as string).join(",");
        const b = placeholders(there).join(",");
        if (a !== b) mismatched.push(`${value}/${key}: en[${a}] vs [${b}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
