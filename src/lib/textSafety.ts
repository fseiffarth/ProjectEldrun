/**
 * Display-text safety primitives — pure, dependency-free, and deliberately so.
 *
 * This module exists because the *rule* and the *reach* came apart. Stripping
 * bidi and zero-width characters out of attacker-chosen text was written once,
 * for the mail client, and lived in `lib/mail.ts` — which imports
 * `@tauri-apps/api/core`. So every other feature that renders text somebody else
 * wrote either imported the whole Tauri invoke surface to get one regex, or (in
 * practice) did without: an imported `.ics` put its `SUMMARY` on screen with no
 * stripping at all, while a mail subject three panes away was cleaned.
 *
 * Keeping the helpers here, with no imports, means the pure layers can use them
 * — `lib/ics.ts` parses with no runtime and is unit-tested with none. `lib/mail.ts`
 * re-exports `stripFormatControls` so its own call sites and public API are
 * unchanged; this is the one definition behind both.
 *
 * The Rust half of the same rule is `services::web_safety::{FORMAT_CHARS,
 * strip_format_controls}`. The two lists are kept identical on purpose, and
 * `src/__tests__/TextSafety.test.ts` reads the Rust one out of that file and
 * fails if they drift.
 */

/**
 * Remove bidi overrides, isolates and zero-width characters from display text.
 *
 * These are what turn a filename with an embedded RLO into something that reads
 * as a harmless `.png`, an event title into one that reads as another calendar's,
 * or a machine label into one that reads as a host it is not.
 *
 * Note what this is *not*: it is not an escape, and it is not a sanitizer. The
 * text is still text, and still has to be rendered as a text node. It removes a
 * class of character whose only effect is to make a string *look* like a
 * different string.
 */
export function stripFormatControls(text: string): string {
  return text.replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u00AD\u061C\u180E\uFEFF]/g,
    "",
  );
}
