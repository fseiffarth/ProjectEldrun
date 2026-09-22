import { UntestedTag } from "./UntestedTag";
import { useShortcutOverrides } from "../../lib/shortcuts/shortcutHint";
import {
  chordLabel,
  resolveChord,
  type ChordDescriptor,
  type ShortcutAction,
} from "../../lib/shortcuts/shortcuts";

/**
 * The muted, right-aligned chord at the end of a menu row — "Close   Ctrl+W",
 * the way desktop IDEs label their menus. Same resolution as `useChordHint`:
 * a rebindable action shows the user's own chord (⌘-glyphed on macOS), a
 * literal descriptor covers the fixed keys handled outside the action table.
 *
 * Only for rows whose chord really does the same thing. `aria-hidden` keeps the
 * row's accessible name its label; the chord is a visual hint, not the name.
 */
export function MenuShortcut({ chord }: { chord: ShortcutAction | ChordDescriptor }) {
  const overrides = useShortcutOverrides();
  const resolved = typeof chord === "string" ? resolveChord(chord, overrides) : chord;
  return (
    <>
      <UntestedTag id="shortcut.menuHints" />
      <span className="menu-shortcut" aria-hidden>
        {chordLabel(resolved)}
      </span>
    </>
  );
}
