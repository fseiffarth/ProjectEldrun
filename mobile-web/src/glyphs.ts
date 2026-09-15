/**
 * The section glyphs the tab bar and the Home alert list share.
 *
 * All four are Unicode symbols without a default emoji presentation. 🗂 and 🗓
 * have no monochrome glyph in the fonts phones ship, so they always fall back
 * to the colour-emoji font; ☑ and ✉ do exist as plain text symbols, so without
 * help they render as thin grey line art beside two full-colour neighbours.
 * The variation selector U+FE0F asks for emoji presentation explicitly — on
 * every glyph, so the row does not depend on which fonts a phone happens to
 * have. It is written as an escape here because it is invisible in source.
 */
const EMOJI = "️";

export const SECTION_GLYPH = {
  projects: `🗂${EMOJI}`,
  todo: `☑${EMOJI}`,
  calendar: `🗓${EMOJI}`,
  mail: `✉${EMOJI}`,
} as const;

/** True when the glyph carries the emoji-presentation selector. */
export function hasEmojiPresentation(glyph: string): boolean {
  return glyph.endsWith(EMOJI);
}
