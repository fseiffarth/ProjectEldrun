/**
 * The phone's tab bar showed Projects and Calendar in colour but To-do and
 * Mail in grey: ☑ and ✉ exist as text symbols, so the phone drew them from a
 * text font, while 🗂 and 🗓 fell back to the colour-emoji font. Every section
 * glyph now carries U+FE0F so all four take the same emoji presentation — an
 * invisible character a tidy-up would strip without noticing, hence this test.
 */
import { describe, expect, it } from "vitest";
import { SECTION_GLYPH, hasEmojiPresentation } from "../../../mobile-web/src/glyphs";

describe("mobile section glyphs", () => {
  it("asks for emoji presentation on every section glyph", () => {
    for (const [section, glyph] of Object.entries(SECTION_GLYPH)) {
      expect(hasEmojiPresentation(glyph), `${section} glyph ${JSON.stringify(glyph)}`).toBe(true);
    }
  });

  it("keeps the base symbols the desktop header uses", () => {
    expect(SECTION_GLYPH.todo.startsWith("☑")).toBe(true);
    expect(SECTION_GLYPH.mail.startsWith("✉")).toBe(true);
    expect(SECTION_GLYPH.calendar.startsWith("🗓")).toBe(true);
    expect(SECTION_GLYPH.projects.startsWith("🗂")).toBe(true);
  });
});
