import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ReviewRow {
  kind: string;
  op: string;
  pre: Record<string, unknown> | null;
  post: Record<string, unknown>;
  local: boolean;
}
export interface RootProposal {
  id: string;
  tab: string;
  tool: string;
  args: Record<string, unknown>;
  created: string;
  rows: ReviewRow[];
  calendars: Record<string, unknown>[];
  tainted: boolean;
  status: string;
  undo: boolean;
  digest: string;
  closed: boolean;
  mcp_caller?: "agent" | "local_model" | "reader";
  mcp_access?: { calendars: { all: boolean; ids: string[] }; projects: { all: boolean; ids: string[] } };
}
interface RootReviewState {
  proposals: RootProposal[];
  count: number;
  error: string | null;
  busy: boolean;
  /** Whether the console's ⚿ badge has its proposals panel dropped. It lives
   *  here rather than in `RootOverlay` because the project bar's ⚿ button opens
   *  the console *at* the proposals — one click from the count to the rows. */
  panel: boolean;
  setPanel: (panel: boolean) => void;
  refresh: () => Promise<void>;
  decide: (proposal: RootProposal, action: "apply" | "reject" | "undo") => Promise<void>;
  applyAll: (proposals: RootProposal[]) => Promise<void>;
}
let refreshVersion = 0;
async function action(command: string, args: Record<string, unknown>) {
  if (useRootReviewStore.getState().busy) return;
  useRootReviewStore.setState({ busy: true, error: null });
  try {
    await invoke(command, args);
    await useRootReviewStore.getState().refresh();
  } catch (error) {
    await useRootReviewStore.getState().refresh();
    useRootReviewStore.setState({ error: String(error) });
  } finally {
    useRootReviewStore.setState({ busy: false });
  }
}
export const useRootReviewStore = create<RootReviewState>((set) => ({
  proposals: [], count: 0, error: null, busy: false, panel: false,
  setPanel: (panel) => set({ panel }),
  refresh: async () => {
    const version = ++refreshVersion;
    try {
      const proposals = await invoke<RootProposal[]>("root_mcp_review_list");
      if (version !== refreshVersion) return;
      set({ proposals, count: proposals.filter((p) => p.status === "pending").length, error: null });
    } catch (error) {
      if (version === refreshVersion) set({ error: String(error) });
    }
  },
  decide: (p, verb) => action(`root_mcp_review_${verb}`, { id: p.id, digest: p.digest }),
  applyAll: (proposals) => action("root_mcp_review_apply_all", {
    approvals: proposals.map(({ id, digest }) => ({ id, digest })),
  }),
}));
