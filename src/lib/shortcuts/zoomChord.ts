/** The Ctrl +/-/0 zoom chord, layout-independent. Matching on `e.code` alone
 *  only works on a US layout: on German QWERTZ `+` sits on `BracketRight` and
 *  `-` on `Slash`, so the printed keys never matched. The typed character
 *  (`e.key`) is read first; the US positions stay as a fallback so the chord
 *  keeps working wherever a layout reports an odd `key` under Ctrl. Shift is
 *  allowed only for `+`, since US types it as Shift+`=`. */
export type ZoomChord = "in" | "out" | "reset";

/** The fields read — a DOM event, a React one, or a stored chord all fit. */
export type ZoomKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function zoomChord(e: ZoomKeyEvent): ZoomChord | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "+" || e.code === "NumpadAdd") return "in";
  if (e.shiftKey) return null;
  if (e.key === "=" || e.code === "Equal") return "in";
  if (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}
