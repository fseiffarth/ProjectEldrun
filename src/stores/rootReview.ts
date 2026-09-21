import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { importIcsText } from "./calendar/importIcs";

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
/** An `.ics` file a root agent staged with `calendar_import_ics`
 *  (`services::root_mcp_import`). Not a proposal: nothing is parsed or written
 *  until the user imports it here, through the calendar's own importer. */
export interface StagedIcsImport {
  id: string;
  tab: string;
  name: string;
  created: string;
  text: string;
}
interface RootReviewState {
  proposals: RootProposal[];
  imports: StagedIcsImport[];
  count: number;
  error: string | null;
  busy: boolean;
  /** Whether the console's ✓ Approvals button has its panel dropped. It lives
   *  here rather than in `RootOverlay` so a flow that floats the console can
   *  open it *at* the rows; the console clears it when it closes. */
  panel: boolean;
  setPanel: (panel: boolean) => void;
  refresh: () => Promise<void>;
  decide: (proposal: RootProposal, action: "apply" | "reject" | "undo") => Promise<void>;
  applyAll: (proposals: RootProposal[]) => Promise<void>;
  /** Import exactly the text the card showed, then drop the staged copy.
   *  `fallbackName` names the new calendar when the agent gave none. */
  importStaged: (staged: StagedIcsImport, fallbackName: string) => Promise<void>;
  discardStaged: (staged: StagedIcsImport) => Promise<void>;
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
  proposals: [], imports: [], count: 0, error: null, busy: false, panel: false,
  setPanel: (panel) => set({ panel }),
  refresh: async () => {
    const version = ++refreshVersion;
    try {
      const [proposals, imports] = await Promise.all([
        invoke<RootProposal[]>("root_mcp_review_list"),
        // Its own failure must not take the proposals down with it: a window
        // hot-reloaded over a backend built before this command has no such list.
        invoke<StagedIcsImport[]>("root_mcp_import_list").catch(() => []),
      ]);
      if (version !== refreshVersion) return;
      set({ proposals, imports: Array.isArray(imports) ? imports : [], count: proposals.filter((p) => p.status === "pending").length, error: null });
    } catch (error) {
      if (version === refreshVersion) set({ error: String(error) });
    }
  },
  decide: (p, verb) => action(`root_mcp_review_${verb}`, { id: p.id, digest: p.digest }),
  applyAll: (proposals) => action("root_mcp_review_apply_all", {
    approvals: proposals.map(({ id, digest }) => ({ id, digest })),
  }),
  importStaged: async (staged, fallbackName) => {
    if (useRootReviewStore.getState().busy) return;
    useRootReviewStore.setState({ busy: true, error: null });
    try {
      // The staged copy goes first: a failed import must not leave a card whose
      // second ✓ imports the same file into a second calendar.
      await invoke("root_mcp_import_remove", { id: staged.id });
      await importIcsText(staged.text, staged.name || fallbackName);
      await useRootReviewStore.getState().refresh();
    } catch (error) {
      await useRootReviewStore.getState().refresh();
      useRootReviewStore.setState({ error: String(error) });
    } finally {
      useRootReviewStore.setState({ busy: false });
    }
  },
  discardStaged: (staged) => action("root_mcp_import_remove", { id: staged.id }),
}));
