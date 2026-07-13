import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "./projects";
import { markVpnConnected, useVpnStatusStore } from "./vpnStatus";

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
  /** What the tunnel is being brought up *for* — a project name, or the config's
   *  own name when the connect came from the header (no project behind it). */
  projectName: string;
  /**
   * Project id, so a username typed here can be persisted to the spec — and so the
   * project is recorded as a holder of the tunnel.
   *
   * `null` for a connect started from the header's VPN menu: the tunnel is a
   * machine-level thing and can legitimately be brought up on its own, with no
   * project asking for it (and therefore no spec to persist a username into).
   */
  projectId: string | null;
  /** Auth username seed for `auth-user-pass` configs (from the stored spec). */
  username?: string;
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
  /** Open the prompt for a project; resolves when connected, rejects on cancel.
   *  `username` seeds the field for `auth-user-pass` configs. */
  request: (
    config: string,
    projectName: string,
    projectId: string | null,
    username?: string,
  ) => Promise<void>;
  /** Attempt the tunnel with `username`/`password`, plus `keyPassphrase` for a
   *  config that has an encrypted key *and* an `auth-user-pass` account (OpenVPN
   *  prompts for those two separately; answering only one hangs the handshake on
   *  the other). `remember` opts into saving the secrets in the OS keychain for
   *  no-prompt reconnects (default off). On success closes + resolves (persisting
   *  the username to the spec); on failure keeps the modal open with the error so
   *  the user can retry. */
  submit: (
    password: string,
    remember?: boolean,
    username?: string,
    keyPassphrase?: string,
  ) => Promise<void>;
  cancel: () => void;
}

export const useVpnPromptStore = create<VpnPromptState>((set, get) => ({
  pending: null,
  status: "idle",
  error: "",
  request: (config, projectName, projectId, username) =>
    new Promise<void>((resolve, reject) => {
      // If a prompt is already open, cancel it before replacing.
      get().pending?.reject(new Error("superseded"));
      set({
        pending: { config, projectName, projectId, username, resolve, reject },
        status: "idle",
        error: "",
      });
    }),
  submit: async (password, remember = false, username, keyPassphrase) => {
    const p = get().pending;
    if (!p || get().status === "connecting") return;
    set({ status: "connecting", error: "" });
    try {
      await invoke("openvpn_connect", {
        config: p.config,
        username: username?.trim() || null,
        password,
        keyPassphrase: keyPassphrase || null,
        remember,
      });
      // The tunnel is up and it owns the machine's routing from here on. Record it
      // machine-level right at the source, so no caller of `request` can resolve
      // without the header indicator lighting. With a project behind it, that project
      // also takes a hold on the tunnel (the refcount that keeps one project's logout
      // from tearing the tunnel out from under another). Callers still mark their own
      // lamp; this is idempotent.
      if (p.projectId) markVpnConnected(p.projectId, p.config);
      else useVpnStatusStore.getState().setState(p.config, "connected");
      // Persist the (non-secret) username so the next activation can auto-connect
      // silently from the keychained password with no prompt. Best-effort. Only with
      // a project: a header-initiated connect has no spec to write it into.
      if (username?.trim() && p.projectId) {
        void useProjectsStore
          .getState()
          .setProjectOpenvpn(p.projectId, p.config, username.trim())
          .catch(() => {});
      }
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
