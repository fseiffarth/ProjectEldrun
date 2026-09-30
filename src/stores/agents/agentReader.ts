import { create } from "zustand";
import { rememberReader, rememberedReader } from "../../lib/agents/agentReader";

/**
 * Whether agent panes show the Reader over their terminal (`TerminalReaderView`).
 * One choice for the whole window, remembered across restarts
 * (`rememberedReader`): picking the Reader in one tab switches every agent
 * pane that offers it, and a pane that does not keeps its terminal.
 */
interface AgentReaderState {
  open: boolean;
  set: (on: boolean) => void;
}

export const useAgentReaderStore = create<AgentReaderState>((set) => ({
  open: rememberedReader(),
  set: (on) => {
    rememberReader(on);
    set({ open: on });
  },
}));

/** Whether a pane shows the Reader: the window's choice, where offered. */
export function useReaderOpen(offered: boolean): boolean {
  const open = useAgentReaderStore((state) => state.open);
  return offered && open;
}
