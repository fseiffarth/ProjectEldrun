/**
 * Ctrl +/-/0 zoom must follow the printed key, not the US key position — on
 * German QWERTZ `+` is `BracketRight` and `-` is `Slash`, so a code-only match
 * left both dead.
 */
import { describe, expect, it } from "vitest";
import { zoomChord } from "../../lib/shortcuts/zoomChord";

const ev = (key: string, code: string, mods: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, code, ctrlKey: true, ...mods });

describe("zoomChord", () => {
  it("reads the German layout's + and - keys", () => {
    expect(zoomChord(ev("+", "BracketRight"))).toBe("in");
    expect(zoomChord(ev("-", "Slash"))).toBe("out");
    expect(zoomChord(ev("0", "Digit0"))).toBe("reset");
  });

  it("keeps the US chords, including Shift+= for +", () => {
    expect(zoomChord(ev("=", "Equal"))).toBe("in");
    expect(zoomChord(ev("+", "Equal", { shiftKey: true }))).toBe("in");
    expect(zoomChord(ev("-", "Minus"))).toBe("out");
  });

  it("takes the numpad keys", () => {
    expect(zoomChord(ev("+", "NumpadAdd"))).toBe("in");
    expect(zoomChord(ev("-", "NumpadSubtract"))).toBe("out");
    expect(zoomChord(ev("0", "Numpad0"))).toBe("reset");
  });

  it("ignores unmodified, Alt and other Shift chords", () => {
    expect(zoomChord(ev("+", "BracketRight", { ctrlKey: false }))).toBeNull();
    expect(zoomChord(ev("-", "Slash", { altKey: true }))).toBeNull();
    expect(zoomChord(ev("_", "Slash", { shiftKey: true }))).toBeNull();
    expect(zoomChord(ev("=", "Digit0", { shiftKey: true }))).toBeNull();
  });
});
