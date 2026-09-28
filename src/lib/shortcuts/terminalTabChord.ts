/** Ctrl+Shift+←/→ (`prevTab` / `nextTab`, or whatever they are rebound to) step
 *  the focused pane's tabs from a focused terminal too. Every other nav chord
 *  stays the terminal's while it has focus (`useKeyboard.isEditableTarget`);
 *  these two are admitted because the hands are in a terminal when the next
 *  tab is wanted. The cost: a program in the terminal (vim, micro, Emacs)
 *  never sees them — which is also why the default isn't plain Shift+Arrow:
 *  an agent CLI in the terminal (Codex) uses that itself. Shift+Tab
 *  (`cycleTabs`) is deliberately not one of them — it is the agent CLIs' mode
 *  cycle.
 *
 *  Two halves: `TerminalView` leaves the chord unhandled (`terminalYieldsChord`)
 *  so xterm neither sends it to the PTY nor cancels the event, and the window's
 *  keyboard handler — main window and popout alike — resolves it from xterm's
 *  textarea (`terminalMayTakeChord`). */
import { chordMatches, resolveChord, type ShortcutAction, type ShortcutMap } from "./shortcuts";

const TERMINAL_TAB_ACTIONS: readonly ShortcutAction[] = ["prevTab", "nextTab"];

/** xterm's helper textarea in a workspace pane. The root console's terminals
 *  are excluded: its overlay sits over the workspace, so stepping the focused
 *  pane's tabs from there would switch tabs the user cannot see. */
export function isPaneTerminalTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.classList?.contains("xterm-helper-textarea") && !el.closest(".root-overlay");
}

/** Whether the window's handler may resolve `action` for a keydown typed into
 *  a pane terminal. */
export function terminalMayTakeChord(action: ShortcutAction, e: KeyboardEvent): boolean {
  return TERMINAL_TAB_ACTIONS.includes(action) && isPaneTerminalTarget(e.target);
}

/** Whether a pane terminal hands this keydown to the window instead of the PTY. */
export function terminalYieldsChord(e: KeyboardEvent, overrides: ShortcutMap | undefined | null): boolean {
  return (
    isPaneTerminalTarget(e.target) &&
    TERMINAL_TAB_ACTIONS.some((action) => chordMatches(resolveChord(action, overrides), e))
  );
}
