import { create } from "zustand";

/**
 * Mediates the HPC tag's confirmation dialog.
 *
 * A machine tagged HPC (`lib/hpcHost.ts`) has its background work switched off
 * outright — sync loops, lockstep polling, auto-connect, full stats. Two things
 * can't be settled that way, because the user sometimes genuinely wants them: a
 * disk-usage scan of the cluster tree, and running a command in a login-node
 * shell. Those are *asked about* instead, once per act, here.
 *
 * The store owns the whole lifecycle so a caller only awaits an answer
 * (`request()` resolves, never rejects) — the same bargain `hostKeyPrompt` and
 * `vpnPrompt` strike. Nothing is remembered between prompts: a tag that could be
 * worn down by clicking through once would not be a gate, and each of these is a
 * specific act rather than a policy.
 */

/** What is being asked about. Mirrors the slugs `services::hpc_mode`'s refusals
 *  carry (`du-scan`, `census`), plus the two the frontend raises on its own. */
export type HpcGuardKind = "du-scan" | "census" | "login-node-run";

interface Pending {
  kind: HpcGuardKind;
  /** `user@host:port`, as the tag is keyed — the dialog names the machine. */
  target: string;
  resolve: (proceed: boolean) => void;
}

interface HpcGuardState {
  pending: Pending | null;
  /** Ask about `kind` on `target`. Resolves `true` only if the user chose to go
   *  ahead anyway, `false` on cancel. */
  request: (kind: HpcGuardKind, target: string) => Promise<boolean>;
  /** Go ahead regardless — the user's call to make. */
  proceed: () => void;
  /** Back out; nothing runs. */
  cancel: () => void;
}

export const useHpcGuardStore = create<HpcGuardState>((set, get) => ({
  pending: null,

  request: (kind, target) =>
    new Promise<boolean>((resolve) => {
      // A second ask while one is open answers the newcomer "no" rather than
      // stacking modals or silently replacing the question being read.
      if (get().pending) {
        resolve(false);
        return;
      }
      set({ pending: { kind, target, resolve } });
    }),

  proceed: () => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(true);
  },

  cancel: () => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(false);
  },
}));
