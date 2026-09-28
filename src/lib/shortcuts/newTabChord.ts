/**
 * The new-tab chords: Ctrl+Shift+N (shell), Ctrl+Shift+M (System Monitor) and
 * Ctrl+1–9 (the + menu's agents by number, 1 = the default agent).
 *
 * `useKeyboard` resolves the keystroke; the focused pane's `TabBar` opens the
 * tab through its own + menu handlers, so a chord and a click build the same
 * tab (worktree question, session ids and all). The two meet over a window
 * event rather than a store because the launch needs that bar's live state.
 */
import { allGroups, useTabsStore } from "../../stores/tabs";
import {
  AGENT_TAB_ACTIONS,
  chordMatches,
  resolveChord,
  type ShortcutMap,
} from "./shortcuts";

/** What a chord asks for. `slot` is 0-based: 0 = Ctrl+1. */
export type NewTabRequest =
  | { kind: "shell" }
  | { kind: "monitor" }
  | { kind: "agent"; slot: number };

/** Detail: {@link NewTabShortcutDetail}. Cancelled (`preventDefault`) by the
 *  bar that opened the tab. */
export const NEW_TAB_SHORTCUT_EVENT = "eldrun:new-tab-shortcut";

export interface NewTabShortcutDetail {
  request: NewTabRequest;
  /** The pane that takes the tab. */
  groupId: string;
}

/** The new-tab request `e` is, if any. */
export function newTabRequestFor(
  e: KeyboardEvent,
  overrides: ShortcutMap | undefined,
): NewTabRequest | null {
  if (chordMatches(resolveChord("newShellTab", overrides), e)) return { kind: "shell" };
  if (chordMatches(resolveChord("newMonitorTab", overrides), e)) return { kind: "monitor" };
  const slot = AGENT_TAB_ACTIONS.findIndex((action) =>
    chordMatches(resolveChord(action, overrides), e),
  );
  return slot >= 0 ? { kind: "agent", slot } : null;
}

/**
 * Ask the main window's focused pane (the first pane when none is focused) to
 * open `request`. True when a bar opened it — false for an agent number with
 * no agent behind it, so the key can go on to wherever it was typed.
 */
export function requestNewTab(request: NewTabRequest): boolean {
  const tabs = useTabsStore.getState();
  const groupId = tabs.focusedGroupId ?? allGroups(tabs.layout)[0]?.id;
  if (!groupId) return false;
  const event = new CustomEvent<NewTabShortcutDetail>(NEW_TAB_SHORTCUT_EVENT, {
    detail: { request, groupId },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}
