import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Mediates the confirmation every **byte-sync transfer** now asks for.
 *
 * Byte-sync's two manual transfers each write one side's bytes over the other's:
 * a pull replaces the local mirror with the host's copy, a push replaces the
 * host's copy with the mirror's. Both used to be a single unconfirmed click — on
 * a file, on a *folder*, or on the whole project — which is fine when the
 * receiving side holds nothing and is data loss when it holds edits nobody else
 * has. From the button alone the two cases are indistinguishable, so the click
 * itself was the hazard: nothing about it said which one you were in.
 *
 * So every transfer asks first, and asks *with numbers*: how many files would
 * move, how many land on top of an existing file, and — the one that matters —
 * how many of those carry changes that exist nowhere else. The count comes from
 * the backend's read-only `sync_transfer_preview`, which walks exactly what the
 * transfer would walk (exclusions included).
 *
 * The store owns the whole lifecycle so a caller only awaits an answer
 * (`request()` resolves, never rejects) — the same bargain `hpcGuardPrompt` and
 * `hostKeyPrompt` strike. Nothing is remembered between prompts: a confirmation
 * that could be worn down by ticking "don't ask again" is not a gate, and each
 * transfer is a specific act rather than a policy.
 *
 * A **failed** preview never becomes a silent yes: the dialog says it could not
 * price the transfer and still requires the click.
 */

/** Which way the bytes move. Mirrors the backend command's `direction`. */
export type SyncDirection = "pull" | "push";

/** What the dialog is being asked about. */
export interface SyncConfirmRequest {
  projectId: string;
  direction: SyncDirection;
  /** Project-relative root of the transfer; `""` is the whole project. */
  relPath: string;
  /** Whether `relPath` names a folder (so the dialog can say "and everything in it"). */
  isDir: boolean;
  /** What to name on screen — a file/folder name, or the project's. */
  label: string;
  /** An explicit file list (the diverged-files view's bulk resolve) instead of
   *  walking `relPath`. Passed straight through to the preview. */
  relPaths?: string[];
  /** The transfer overwrites the other side **even where it changed** (the orange
   *  view's take-this-side actions). That turns what would have been a blocked
   *  conflict into a destroyed file, which is exactly what the dialog must say. */
  force?: boolean;
}

/** The read-only answer to "what would this transfer actually do?". */
export interface SyncTransferPreview {
  files: number;
  bytes: number;
  overwrites: number;
  /** Receiving-side paths whose content would be lost (capped list). */
  destructive: string[];
  destructiveTotal: number;
  /** Push only, non-forced: files that would be blocked as stale instead. */
  conflicts: number;
  /** False when the receiving side was too large to inspect up front — the
   *  overwrite/destructive counts are then *unknown*, not zero. */
  exact: boolean;
}

interface Pending extends SyncConfirmRequest {
  preview: SyncTransferPreview | null;
  loading: boolean;
  /** Why the preview could not be read, when it could not. */
  error: string | null;
  resolve: (proceed: boolean) => void;
}

interface SyncConfirmState {
  pending: Pending | null;
  /** Ask about a transfer. Resolves `true` only if the user confirmed. */
  request: (req: SyncConfirmRequest) => Promise<boolean>;
  /** Go ahead with the transfer. */
  proceed: () => void;
  /** Back out; nothing transfers. */
  cancel: () => void;
}

export const useSyncConfirmStore = create<SyncConfirmState>((set, get) => ({
  pending: null,

  request: (req) =>
    new Promise<boolean>((resolve) => {
      // A second ask while one is open answers the newcomer "no" rather than
      // stacking modals or swapping the question out from under the reader.
      if (get().pending) {
        resolve(false);
        return;
      }
      set({ pending: { ...req, preview: null, loading: true, error: null, resolve } });
      // Price it in the background. The dialog is already up and already
      // requires a click, so a slow or failing preview costs information, never
      // the gate itself.
      void invoke<SyncTransferPreview>("sync_transfer_preview", {
        projectId: req.projectId,
        relPath: req.relPath,
        direction: req.direction,
        force: !!req.force,
        relPaths: req.relPaths ?? null,
      })
        .then((preview) => {
          const p = get().pending;
          // Guard against a preview landing after the user already answered (or
          // after a different request took the slot).
          if (!p || p.resolve !== resolve) return;
          set({ pending: { ...p, preview, loading: false } });
        })
        .catch((e) => {
          const p = get().pending;
          if (!p || p.resolve !== resolve) return;
          set({ pending: { ...p, loading: false, error: String(e) } });
        });
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

/** Ask before a transfer. Shorthand for `useSyncConfirmStore.getState().request`,
 *  so call sites read as one line: `if (!(await confirmSyncTransfer(...))) return;` */
export function confirmSyncTransfer(req: SyncConfirmRequest): Promise<boolean> {
  return useSyncConfirmStore.getState().request(req);
}
