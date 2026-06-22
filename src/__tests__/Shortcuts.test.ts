/**
 * Group L / #62 — shared shortcut model helpers.
 *
 * Verifies the chord capture/serialization round-trip (KeyboardEvent → chord
 * descriptor → matcher) and the default-resolution / lone-modifier behaviour
 * that both `useKeyboard` and the settings panel depend on.
 */
import { describe, it, expect } from "vitest";
import {
  SHORTCUT_DEFS,
  chordFromEvent,
  chordLabel,
  chordMatches,
  isLoneModifier,
  normalizeKey,
  resolveChord,
} from "../lib/shortcuts";

describe("#62 shortcut helpers", () => {
  it("round-trips a KeyboardEvent to a chord and back to a matcher", () => {
    const e = new KeyboardEvent("keydown", {
      key: "W",
      ctrlKey: true,
      shiftKey: true,
    });
    const chord = chordFromEvent(e)!;
    expect(chord).toEqual({ key: "w", ctrl: true, shift: true });
    // The derived chord matches an equivalent event (key case-insensitive).
    expect(
      chordMatches(
        chord,
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    // And does NOT match when a modifier differs.
    expect(
      chordMatches(chord, new KeyboardEvent("keydown", { key: "w", ctrlKey: true })),
    ).toBe(false);
  });

  it("preserves named keys (Tab, ArrowLeft) verbatim", () => {
    const tab = chordFromEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }))!;
    expect(tab).toEqual({ key: "Tab", shift: true });
    expect(normalizeKey("ArrowLeft")).toBe("ArrowLeft");
  });

  it("ignores lone modifier keypresses", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta", "Super"]) {
      expect(isLoneModifier(k)).toBe(true);
      expect(chordFromEvent(new KeyboardEvent("keydown", { key: k }))).toBeNull();
    }
  });

  it("resolveChord returns the override when present, else the default", () => {
    const def = SHORTCUT_DEFS.find((d) => d.action === "closeTab")!.default;
    expect(resolveChord("closeTab", null)).toEqual(def);
    expect(resolveChord("closeTab", {})).toEqual(def);
    const custom = { key: "q", ctrl: true };
    expect(resolveChord("closeTab", { closeTab: custom })).toEqual(custom);
  });

  it("renders readable chord labels", () => {
    expect(chordLabel({ key: "Tab", ctrl: true, shift: true })).toBe("Ctrl+Shift+Tab");
    expect(chordLabel({ key: "ArrowLeft", shift: true })).toBe("Shift+←");
    expect(chordLabel({ key: "w", ctrl: true })).toBe("Ctrl+W");
  });
});
