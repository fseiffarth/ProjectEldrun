import { useState } from "react";
import { create } from "zustand";
import { rememberReader, rememberedReader } from "../../lib/agents/agentReader";

/**
 * Which agent panes show the Reader over their terminal (`TerminalReaderView`),
 * by PTY id. Window-local and in memory: a pane nobody switched here opens on
 * the view last picked for its agent CLI (`rememberedReader`), the terminal
 * until the Reader has been picked once.
 */
interface AgentReaderState {
  byPty: Record<string, boolean>;
  set: (ptyId: string, agent: string, on: boolean) => void;
}

export const useAgentReaderStore = create<AgentReaderState>((set) => ({
  byPty: {},
  set: (ptyId, agent, on) => {
    rememberReader(agent, on);
    set((state) => ({ byPty: { ...state.byPty, [ptyId]: on } }));
  },
}));

/** Whether the pane `ptyId` running `agent` shows the Reader. The
 * remembered choice is read once, when the pane mounts: picking the Reader in
 * one tab does not switch the other open tabs of that CLI. */
export function useReaderOpen(ptyId: string, agent: string, offered: boolean): boolean {
  const chosen = useAgentReaderStore((state) => state.byPty[ptyId]);
  const [remembered] = useState(() => rememberedReader(agent));
  if (!offered) return false;
  return chosen ?? remembered;
}
