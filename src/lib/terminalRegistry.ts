import type { Terminal } from "@xterm/xterm";

/**
 * The live xterm behind each terminal pane, by composed PTY id — so a store
 * can read what a tab has on screen (`lib/agentPromptEcho`) without the pane
 * handing its terminal around. `TerminalView` registers the terminal the
 * moment it owns one and retires it with the same teardown that clears its
 * own refs, so an entry here is a live terminal or nothing. Per window: a
 * popout's panes register in the popout.
 */
const terminals = new Map<string, Terminal>();

export function registerTerminal(ptyId: string, term: Terminal): void {
  terminals.set(ptyId, term);
}

export function unregisterTerminal(ptyId: string, term: Terminal): void {
  if (terminals.get(ptyId) === term) terminals.delete(ptyId);
}

export function terminalFor(ptyId: string): Terminal | undefined {
  return terminals.get(ptyId);
}
