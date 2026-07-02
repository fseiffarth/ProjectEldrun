import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Mediates the activation-time OpenVPN connection. By default the VPN password
 * is not persisted, so each time a VPN-gated project is activated we ask for it
 * via a modal — unless the user ticked "Save passphrase", in which case the
 * backend reconnects silently from the OS keychain and this prompt is skipped
 * (see `ensureVpnIfNeeded` and services::remote_credentials).
 *
 * The store owns the whole connect lifecycle — not just collecting the password
 * — so a failed tunnel surfaces *in the modal* (status + error, with a retry)
 * instead of failing silently in the background. `request()` resolves once the
 * tunnel is up and rejects if the user cancels.
 */
interface PendingPrompt {
  config: string;
  projectName: string;
  /** Resolved once the tunnel is up. */
  resolve: () => void;
  /** Rejected if the user cancels (or the prompt is superseded). */
  reject: (reason?: unknown) => void;
}

type ConnectStatus = "idle" | "connecting" | "error";

interface VpnPromptState {
  pending: PendingPrompt | null;
  status: ConnectStatus;
  error: string;
  /** Open the prompt for a project; resolves when connected, rejects on cancel. */
  request: (config: string, projectName: string) => Promise<void>;
  /** Attempt the tunnel with `password`. `remember` opts into saving it in the
   *  OS keychain for no-prompt reconnects (default off). On success closes +
   *  resolves; on failure keeps the modal open with the error so the user can
   *  retry. */
  submit: (password: string, remember?: boolean) => Promise<void>;
  cancel: () => void;
}

export const useVpnPromptStore = create<VpnPromptState>((set, get) => ({
  pending: null,
  status: "idle",
  error: "",
  request: (config, projectName) =>
    new Promise<void>((resolve, reject) => {
      // If a prompt is already open, cancel it before replacing.
      get().pending?.reject(new Error("superseded"));
      set({ pending: { config, projectName, resolve, reject }, status: "idle", error: "" });
    }),
  submit: async (password, remember = false) => {
    const p = get().pending;
    if (!p || get().status === "connecting") return;
    set({ status: "connecting", error: "" });
    try {
      await invoke("openvpn_connect", { config: p.config, password, remember });
      set({ pending: null, status: "idle", error: "" });
      p.resolve();
    } catch (e) {
      // Keep the modal open so the user can fix the passphrase and retry.
      set({ status: "error", error: String(e) });
    }
  },
  cancel: () => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null, status: "idle", error: "" });
    p.reject(new Error("cancelled"));
  },
}));
