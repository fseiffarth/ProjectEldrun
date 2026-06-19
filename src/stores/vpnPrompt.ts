import { create } from "zustand";

/**
 * Mediates the activation-time OpenVPN password prompt. The VPN password is
 * never persisted (see services::openvpn), so each time a VPN-gated project is
 * activated we ask for it via a modal. `request()` returns a promise that
 * resolves with the entered password or rejects if the user cancels.
 */
interface PendingPrompt {
  config: string;
  projectName: string;
  resolve: (password: string) => void;
  reject: (reason?: unknown) => void;
}

interface VpnPromptState {
  pending: PendingPrompt | null;
  /** Open the prompt for a project; resolves with the password, rejects on cancel. */
  request: (config: string, projectName: string) => Promise<string>;
  submit: (password: string) => void;
  cancel: () => void;
}

export const useVpnPromptStore = create<VpnPromptState>((set, get) => ({
  pending: null,
  request: (config, projectName) =>
    new Promise<string>((resolve, reject) => {
      // If a prompt is already open, cancel it before replacing.
      get().pending?.reject(new Error("superseded"));
      set({ pending: { config, projectName, resolve, reject } });
    }),
  submit: (password) => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.resolve(password);
  },
  cancel: () => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.reject(new Error("cancelled"));
  },
}));
