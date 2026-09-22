import { create } from "zustand";
import type { TrustRequest } from "../lib/execTrust";

/**
 * The one pending "run this project's hooks / latexmkrc / prettier?" question
 * (`services::exec_trust`). A store rather than component state because the
 * question is raised from wherever the gated action started — the git panel, a
 * viewer's Build or Format button, the publish flow — and answered by the one
 * `ExecTrustHost` mounted per window.
 */
interface ExecTrustStore {
  pending: { request: TrustRequest; resolve: (approved: boolean) => void } | null;
  ask: (request: TrustRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

export const useExecTrustStore = create<ExecTrustStore>((set, get) => ({
  pending: null,
  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // A second question supersedes the first; the first counts as declined.
      get().pending?.resolve(false);
      set({ pending: { request, resolve } });
    }),
  answer: (approved) => {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(approved);
  },
}));
