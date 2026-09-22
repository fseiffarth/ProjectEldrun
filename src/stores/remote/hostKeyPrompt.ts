import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Mediates the first-contact host-key confirmation.
 *
 * The backend refuses to send a password to a host whose SSH key has never been
 * accepted on this machine (`ssh_common::guard_first_contact`) — `accept-new`
 * silently trusts a first key, which is the ordinary TOFU bargain for key auth
 * but not for a secret. This store is the other half: it fetches the keys the
 * host is offering and shows their fingerprints so the user can decide, and only
 * on a yes does it write them to `~/.ssh/known_hosts` (which is what clears the
 * gate — there is no separate "confirmed" state to keep in step).
 *
 * Like `vpnPrompt`, the store owns the whole lifecycle so a failed scan surfaces
 * *in the modal* rather than as a silent nothing, and `request()` resolves with
 * the user's answer instead of throwing.
 */

/** One key the host offered, as `ssh-keygen -l` reports it. */
export interface HostKeyFingerprint {
  keyType: string;
  fingerprint: string;
  bits: number;
}

interface HostKeyPreview {
  target: string;
  known: boolean;
  keys: HostKeyFingerprint[];
  /** Opaque known_hosts text; handed back verbatim so what is stored is what was
   *  shown. Never re-scanned at accept time. */
  scan: string;
}

interface PendingPrompt {
  /** `host:port` as the backend resolved it (after `~/.ssh/config`), so the modal
   *  names the machine the key belongs to and not the alias that was typed. */
  target: string;
  /** Resolved with `true` once the key is trusted, `false` on cancel. Never
   *  rejects: the caller's fallback is simply "don't connect". */
  resolve: (trusted: boolean) => void;
}

type Status = "loading" | "ready" | "trusting" | "error";

interface HostKeyPromptState {
  pending: PendingPrompt | null;
  status: Status;
  error: string;
  keys: HostKeyFingerprint[];
  scan: string;
  /** Open the confirmation for `target` (`host` or `host:port`). Resolves `true`
   *  when the user accepted the key, `false` otherwise. */
  request: (target: string) => Promise<boolean>;
  /** Write the shown keys to known_hosts and resolve the caller with `true`. */
  accept: () => Promise<void>;
  /** Dismiss without trusting; the caller's connect stays failed. */
  cancel: () => void;
}

/** Split `host:port` / bare `host` into what the preview command wants. */
function splitTarget(target: string): { host: string; port: number | null } {
  const at = target.lastIndexOf(":");
  if (at <= 0) return { host: target, port: null };
  const port = Number(target.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0) return { host: target, port: null };
  return { host: target.slice(0, at), port };
}

export const useHostKeyPromptStore = create<HostKeyPromptState>((set, get) => ({
  pending: null,
  status: "loading",
  error: "",
  keys: [],
  scan: "",
  request: (target) =>
    new Promise<boolean>((resolve) => {
      // A prompt already open is answered "no" before being replaced — its caller
      // must not be left hanging on a modal that is no longer on screen.
      get().pending?.resolve(false);
      set({ pending: { target, resolve }, status: "loading", error: "", keys: [], scan: "" });
      const { host, port } = splitTarget(target);
      void invoke<HostKeyPreview>("ssh_host_key_preview", { host, port })
        .then((preview) => {
          if (get().pending?.resolve !== resolve) return; // superseded
          // Already known — the gate was cleared while we were asking (another
          // connect accepted it). Nothing to confirm; let the caller retry.
          if (preview.known) {
            set({ pending: null, status: "ready", keys: [], scan: "" });
            resolve(true);
            return;
          }
          set({ status: "ready", keys: preview.keys, scan: preview.scan });
        })
        .catch((e) => {
          if (get().pending?.resolve !== resolve) return;
          // Can't show a fingerprint ⇒ can't ask the question. The modal says so
          // and offers only Cancel: there is nothing here to accept.
          set({ status: "error", error: String(e), keys: [], scan: "" });
        });
    }),
  accept: async () => {
    const p = get().pending;
    const scan = get().scan;
    if (!p || !scan || get().status === "trusting") return;
    set({ status: "trusting", error: "" });
    try {
      await invoke("ssh_trust_host_key", { scan });
      if (get().pending !== p) return;
      set({ pending: null, status: "ready", error: "", keys: [], scan: "" });
      p.resolve(true);
    } catch (e) {
      if (get().pending !== p) return;
      set({ status: "error", error: String(e) });
    }
  },
  cancel: () => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null, status: "ready", error: "", keys: [], scan: "" });
    p.resolve(false);
  },
}));
