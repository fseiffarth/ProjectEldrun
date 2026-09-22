/**
 * A stable colour per project box. Every place a box appears — its pill in the
 * row's leading segment, the swatch on each member's project pill, the rows of
 * the chip's dropdown and of a pill's Boxes menu — wears the same colour, so a
 * box is recognised by colour before it is read by name, and a member pill's
 * swatch answers "which box" without a tooltip.
 *
 * Hashed from the box's **id**, not its name: renaming a box must not recolour
 * it (the colour is what the eye has learned), and two boxes with the same
 * name still tell apart. Same hue/saturation/lightness recipe as
 * `categoryColor`, so box colours and category colours sit in one family and
 * stay legible on both light and dark headers.
 */
import { hashString } from "./categoryColor";

export function boxColor(boxId: string): string {
  // The djb2 hash of short, similar ids (ULIDs, uuids sharing a prefix) lands
  // on nearby hues; spreading by the golden angle keeps neighbours apart.
  const hue = Math.round((hashString(boxId) * 137.508) % 360);
  return `hsl(${hue} 62% 58%)`;
}
